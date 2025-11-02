/**
 * Test script to migrate one journal entry from Contentful to Strapi Magazine Post
 * Focuses on properly handling Rich Text fields with embedded images
 */

require('dotenv').config()
const {
  contentfulClient,
  createStrapiEntry,
  getStrapiEntries,
  uploadMediaToStrapi,
  strapiRequest,
  mapText,
  sleep,
} = require('./utils')

async function testJournalRichText() {
  console.log('\n🧪 Testing Journal (Rich Text) migration to Magazine Post...\n')

  try {
    // Step 1: Fetch one journal from Contentful
    console.log('📋 Step 1: Fetching a journal from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'journal',
      include: 10, // Include assets for embedded images
      limit: 1,
    })

    if (response.items.length === 0) {
      console.error('❌ No journals found in Contentful')
      return
    }

    const contentfulJournal = response.items[0]
    const fields = contentfulJournal.fields

    console.log(`   Title: ${fields.title}`)
    console.log(`   Slug: ${fields.slug}`)
    console.log(`   Has body field: ${!!fields.body}`)
    console.log(`   Body type: ${fields.body?.nodeType || 'N/A'}`)
    
    // Inspect the rich text structure
    if (fields.body) {
      console.log(`   Rich text structure:`)
      console.log(`     Node type: ${fields.body.nodeType}`)
      console.log(`     Content nodes: ${fields.body.content?.length || 0}`)
      
      // Check for embedded entries/assets
      const hasEmbeddedAssets = JSON.stringify(fields.body).includes('embedded-asset-block')
      console.log(`     Has embedded assets: ${hasEmbeddedAssets}`)
      
      // Count different node types
      const nodeTypes = {}
      function countNodes(node) {
        if (node.nodeType) {
          nodeTypes[node.nodeType] = (nodeTypes[node.nodeType] || 0) + 1
        }
        if (node.content && Array.isArray(node.content)) {
          node.content.forEach(child => countNodes(child))
        }
      }
      countNodes(fields.body)
      console.log(`     Node types found:`, nodeTypes)
    }
    console.log('')

    // Step 2: Check Strapi journal/magazine post structure
    console.log('📋 Step 2: Checking Strapi Journal (Magazine Post) content type...')
    try {
      await getStrapiEntries('journals', { _limit: 1 })
      console.log('   ✅ Journal (Magazine Post) content type exists')
    } catch (error) {
      console.log('   ⚠️  Journal content type might not be accessible yet')
      console.log(`   Error: ${error.message.substring(0, 100)}`)
    }
    console.log('')

    // Step 3: Convert Contentful Rich Text to Strapi Rich Text format
    console.log('📋 Step 3: Converting Contentful Rich Text to Strapi format...')
    
    /**
     * Contentful Rich Text uses a node-based structure:
     * {
     *   nodeType: 'document',
     *   content: [
     *     { nodeType: 'paragraph', content: [...] },
     *     { nodeType: 'embedded-asset-block', data: { target: { sys: { id: '...' } } } },
     *     ...
     *   ]
     * }
     * 
     * Strapi Rich Text uses blocks format:
     * [
     *   { type: 'paragraph', children: [...] },
     *   { type: 'image', image: { id: ..., url: ... } },
     *   ...
     * ]
     */
    
    function convertContentfulRichTextToStrapi(contentfulRichText, assetMap = {}) {
      if (!contentfulRichText || !contentfulRichText.content) {
        return []
      }

      const strapiBlocks = []

      function processNode(node) {
        switch (node.nodeType) {
          case 'document':
            // Process all content nodes
            if (node.content) {
              node.content.forEach(child => processNode(child))
            }
            break

          case 'paragraph':
            const paragraphChildren = []
            if (node.content) {
              node.content.forEach(child => {
                if (child.nodeType === 'text') {
                  let textNode = {
                    type: 'text',
                    text: child.value || '',
                  }
                  // Handle marks (bold, italic, etc.)
                  if (child.marks && child.marks.length > 0) {
                    child.marks.forEach(mark => {
                      if (mark.type === 'bold') textNode.bold = true
                      if (mark.type === 'italic') textNode.italic = true
                      if (mark.type === 'underline') textNode.underline = true
                      if (mark.type === 'code') textNode.code = true
                    })
                  }
                  paragraphChildren.push(textNode)
                }
              })
            }
            if (paragraphChildren.length > 0) {
              strapiBlocks.push({
                type: 'paragraph',
                children: paragraphChildren,
              })
            }
            break

          case 'heading-1':
          case 'heading-2':
          case 'heading-3':
          case 'heading-4':
          case 'heading-5':
          case 'heading-6':
            const level = parseInt(node.nodeType.replace('heading-', ''))
            const headingChildren = []
            if (node.content) {
              node.content.forEach(child => {
                if (child.nodeType === 'text') {
                  headingChildren.push({
                    type: 'text',
                    text: child.value || '',
                  })
                }
              })
            }
            if (headingChildren.length > 0) {
              strapiBlocks.push({
                type: 'heading',
                level,
                children: headingChildren,
              })
            }
            break

          case 'embedded-asset-block':
            // This is an embedded image
            const assetId = node.data?.target?.sys?.id
            if (assetId && strapiAssetMap[assetId]) {
              // Strapi richtext image format - use the uploaded media ID
              strapiBlocks.push({
                type: 'image',
                image: strapiAssetMap[assetId], // Strapi media ID
              })
              console.log(`     ✅ Added embedded image block (media ID: ${strapiAssetMap[assetId]})`)
            } else {
              console.log(`     ⚠️  Embedded asset ${assetId} not found or not uploaded`)
            }
            break

          case 'unordered-list':
          case 'ordered-list':
            const listType = node.nodeType === 'unordered-list' ? 'list' : 'numbered-list'
            const listItems = []
            if (node.content) {
              node.content.forEach(listItem => {
                if (listItem.nodeType === 'list-item' && listItem.content) {
                  const itemChildren = []
                  listItem.content.forEach(para => {
                    if (para.nodeType === 'paragraph' && para.content) {
                      para.content.forEach(text => {
                        if (text.nodeType === 'text') {
                          itemChildren.push({
                            type: 'text',
                            text: text.value || '',
                          })
                        }
                      })
                    }
                  })
                  if (itemChildren.length > 0) {
                    listItems.push({
                      type: 'list-item',
                      children: itemChildren,
                    })
                  }
                }
              })
            }
            if (listItems.length > 0) {
              strapiBlocks.push({
                type: listType,
                children: listItems,
              })
            }
            break

          case 'blockquote':
            const quoteChildren = []
            if (node.content) {
              node.content.forEach(para => {
                if (para.nodeType === 'paragraph' && para.content) {
                  para.content.forEach(text => {
                    if (text.nodeType === 'text') {
                      quoteChildren.push({
                        type: 'text',
                        text: text.value || '',
                      })
                    }
                  })
                }
              })
            }
            if (quoteChildren.length > 0) {
              strapiBlocks.push({
                type: 'quote',
                children: quoteChildren,
              })
            }
            break

          case 'hyperlink':
            // Links are usually embedded within paragraph text nodes
            // We'll handle them when processing text nodes with link marks
            const linkText = node.content?.[0]?.value || ''
            const linkUrl = node.data?.uri || ''
            // For now, convert links to plain text with URL
            // TODO: Implement proper link handling in paragraphs
            if (linkText && linkUrl) {
              strapiBlocks.push({
                type: 'paragraph',
                children: [{
                  type: 'text',
                  text: `${linkText} (${linkUrl})`,
                }],
              })
            }
            break

          default:
            console.log(`     ⚠️  Unhandled node type: ${node.nodeType}`)
        }
      }

      processNode(contentfulRichText)
      return strapiBlocks
    }

    // Step 4: Extract and upload embedded images
    console.log('📋 Step 4: Extracting embedded images from Rich Text...')
    const embeddedAssetIds = []
    
    function extractEmbeddedAssets(node) {
      if (node.nodeType === 'embedded-asset-block') {
        const assetId = node.data?.target?.sys?.id
        if (assetId) {
          embeddedAssetIds.push(assetId)
        }
      }
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(child => extractEmbeddedAssets(child))
      }
    }

    if (fields.body) {
      extractEmbeddedAssets(fields.body)
    }

    console.log(`   Found ${embeddedAssetIds.length} embedded assets`)

    // Resolve assets from includes
    const assetMap = {}
    if (response.includes?.Asset) {
      embeddedAssetIds.forEach(assetId => {
        const asset = response.includes.Asset.find(a => a.sys.id === assetId)
        if (asset) {
          assetMap[assetId] = asset
        }
      })
    }

    // Upload assets to Strapi
    const strapiAssetMap = {} // Map Contentful asset ID -> Strapi media object
    for (const [assetId, asset] of Object.entries(assetMap)) {
      console.log(`   Uploading embedded image: ${asset.fields?.file?.fileName || assetId}...`)
      const uploadResult = await uploadMediaToStrapi(asset, 'embedded-image')
      
      // Handle null, ID (number), and object with id/sizeMB formats
      if (!uploadResult) {
        console.log(`     ⚠️  Upload failed, skipping this asset`)
        continue
      }
      
      const strapiMediaId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
      const sizeMB = typeof uploadResult === 'object' && uploadResult.sizeMB ? uploadResult.sizeMB : 0
      
      if (strapiMediaId) {
        strapiAssetMap[assetId] = strapiMediaId
        console.log(`     ✅ Uploaded (ID: ${strapiMediaId})`)
        
        // Dynamic delay based on file size - larger files need more time
        // Base delay of 3 seconds, plus 1 second per MB for files over 5MB
        let delayMs = 3000
        if (sizeMB > 5) {
          delayMs = 3000 + (sizeMB * 1000) // 3s base + 1s per MB
          console.log(`     ⏳ Waiting ${(delayMs/1000).toFixed(1)} seconds (large file: ${sizeMB.toFixed(2)}MB)...`)
        } else {
          console.log(`     ⏳ Waiting 3 seconds before next upload...`)
        }
        
        // Only wait if there are more uploads
        if (Object.keys(strapiAssetMap).length < Object.keys(assetMap).length) {
          await sleep(delayMs)
        }
      }
    }
    console.log('')

    // Step 5: Convert rich text
    console.log('📋 Step 5: Converting Rich Text format...')
    const strapiRichText = convertContentfulRichTextToStrapi(fields.body, strapiAssetMap)
    console.log(`   Converted to ${strapiRichText.length} Strapi blocks`)
    console.log(`   Block types: ${strapiRichText.map(b => b.type).join(', ')}`)
    console.log('')

    // Step 6: Create journal (magazine post) entry
    console.log('📋 Step 6: Creating Journal (Magazine Post) entry...')
    const testSlug = (fields.slug || 'test-journal') + '-test'
    
    // Delete existing test entry if it exists
    try {
      const existing = await getStrapiEntries('journals', { filters: { slug: { $eq: testSlug } } })
      if (existing && existing.length > 0) {
        console.log('   ⚠️  Test entry exists, deleting it first...')
        const entryId = existing[0].documentId || existing[0].id
        await strapiRequest(`/api/journals/${entryId}`, { method: 'DELETE' })
        await sleep(2000)
        console.log('   ✅ Deleted')
      }
    } catch (e) {
      // Ignore
    }

    // Upload featuredImage and thumbnailImage if they exist
    let featuredImageId = null
    let thumbnailImageId = null
    
    if (fields.featuredImage) {
      console.log('   📤 Uploading featuredImage...')
      let featuredImageAsset = fields.featuredImage
      if (featuredImageAsset.sys && featuredImageAsset.sys.type === 'Link') {
        featuredImageAsset = response.includes?.Asset?.find(
          asset => asset.sys.id === featuredImageAsset.sys.id
        )
      }
      if (featuredImageAsset && featuredImageAsset.fields) {
        const uploadResult = await uploadMediaToStrapi(featuredImageAsset, 'featuredImage')
        if (uploadResult) {
          featuredImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
          const sizeMB = typeof uploadResult === 'object' && uploadResult.sizeMB ? uploadResult.sizeMB : 0
          
          if (featuredImageId) {
            console.log(`     ✅ Uploaded (ID: ${featuredImageId})`)
            const delayMs = sizeMB > 5 ? 3000 + (sizeMB * 1000) : 3000
            console.log(`     ⏳ Waiting ${(delayMs/1000).toFixed(1)} seconds before next upload...`)
            await sleep(delayMs)
          }
        } else {
          console.log(`     ⚠️  FeaturedImage upload failed, continuing without it`)
        }
      }
    }

    if (fields.thumbnailImage) {
      console.log('   📤 Uploading thumbnailImage...')
      let thumbnailImageAsset = fields.thumbnailImage
      if (thumbnailImageAsset.sys && thumbnailImageAsset.sys.type === 'Link') {
        thumbnailImageAsset = response.includes?.Asset?.find(
          asset => asset.sys.id === thumbnailImageAsset.sys.id
        )
      }
      if (thumbnailImageAsset && thumbnailImageAsset.fields) {
        const uploadResult = await uploadMediaToStrapi(thumbnailImageAsset, 'thumbnailImage')
        if (uploadResult) {
          thumbnailImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
          const sizeMB = typeof uploadResult === 'object' && uploadResult.sizeMB ? uploadResult.sizeMB : 0
          
          if (thumbnailImageId) {
            console.log(`     ✅ Uploaded (ID: ${thumbnailImageId})`)
            const delayMs = sizeMB > 5 ? 3000 + (sizeMB * 1000) : 3000
            console.log(`     ⏳ Waiting ${(delayMs/1000).toFixed(1)} seconds before creating entry...`)
            await sleep(delayMs)
          }
        } else {
          console.log(`     ⚠️  ThumbnailImage upload failed, continuing without it`)
        }
      }
    }

    // Map other fields
    const strapiData = {
      title: mapText(fields.title),
      slug: testSlug,
      titleColor: mapText(fields.titleColor),
      comingSoon: fields.comingSoon || false,
      featuredStory: fields.featuredStory || false,
      introduction: mapText(fields.introduction),
      body: JSON.stringify(strapiRichText), // Strapi richtext expects a JSON string
      // Media will be attached separately
    }

    console.log('   Entry data preview:', JSON.stringify({
      title: strapiData.title,
      slug: strapiData.slug,
      contentBlocks: strapiRichText.length,
      hasFeaturedImage: !!featuredImageId,
      hasThumbnailImage: !!thumbnailImageId,
    }, null, 2))

    // Try to create entry - even if media uploads failed, we can still test Rich Text
    const strapiEntry = await createStrapiEntry('journals', strapiData)
    console.log(`   ✅ Created magazine post entry (ID: ${strapiEntry.id}, documentId: ${strapiEntry.documentId})`)
    
    // If we have media IDs, attach them separately
    if (featuredImageId || thumbnailImageId) {
      console.log('   🔄 Attaching media to entry...')
      const entryId = strapiEntry.documentId || strapiEntry.id
      const updateData = {}
      if (featuredImageId) updateData.featuredImage = featuredImageId
      if (thumbnailImageId) updateData.thumbnailImage = thumbnailImageId
      
      try {
        await strapiRequest(`/api/journals/${entryId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: updateData }),
        })
        console.log(`   ✅ Media attached successfully`)
      } catch (error) {
        console.log(`   ⚠️  Could not attach media (check manually): ${error.message.substring(0, 100)}`)
      }
    }
    console.log('')

    console.log('✅ Test completed!')
    console.log('\n📝 Summary:')
    console.log(`   - Rich Text: ${strapiRichText.length} blocks converted`)
    console.log(`   - Embedded images: ${Object.keys(strapiAssetMap).length} uploaded and referenced`)
    console.log(`   - Featured image: ${featuredImageId ? 'Uploaded' : 'Failed/Skipped'}`)
    console.log(`   - Thumbnail image: ${thumbnailImageId ? 'Uploaded' : 'Failed/Skipped'}`)
    console.log('\n📝 Next steps:')
    console.log('   1. Check the Strapi admin panel to verify the Rich Text content')
    console.log('   2. Verify all embedded images are properly displayed')
    console.log('   3. Check formatting (headings, bold, italic, etc.)')
    console.log('   4. If Rich Text looks good, we can proceed with full migration (media uploads may need retry)')

  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error(error.stack)
    throw error
  }
}

testJournalRichText().catch(console.error)

