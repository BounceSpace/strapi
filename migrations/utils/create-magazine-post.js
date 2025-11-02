/**
 * Test script to migrate ONE journal entry from Contentful to Strapi Magazine Post
 * Tests the retry logic for media uploads and Rich Text conversion
 */

require('dotenv').config()
const {
  contentfulClient,
  createStrapiEntry,
  getStrapiEntries,
  uploadMediaToStrapi,
  strapiRequest,
  convertContentfulRichTextToStrapi,
  mapText,
  mapBoolean,
  sleep,
} = require('./index')

async function createMagazinePost(journalIdOrSlug = null) {
  console.log('\n🚀 Migrating Single Journal -> Magazine Post...\n')

  // Set overall timeout: 4 minutes max for entire migration
  const MAX_MIGRATION_TIME_MS = 4 * 60 * 1000 // 4 minutes
  const migrationStartTime = Date.now()
  
  function checkMigrationTimeout() {
    const elapsed = Date.now() - migrationStartTime
    if (elapsed > MAX_MIGRATION_TIME_MS) {
      const elapsedSeconds = (elapsed / 1000).toFixed(0)
      throw new Error(`Migration timeout: Exceeded 4 minute limit (ran for ${elapsedSeconds} seconds). Migration aborted for safety.`)
    }
  }

  try {
    // Step 1: Fetch the specific journal from Contentful
    console.log('📋 Step 1: Fetching journal from Contentful...')
    
    let contentfulJournal = null
    let response = null
    
    if (journalIdOrSlug) {
      // Try fetching by slug first (most common)
      response = await contentfulClient.getEntries({
        content_type: 'journal',
        include: 10,
        'fields.slug': journalIdOrSlug,
      })
      
      if (response.items.length === 0) {
        // If slug doesn't work, try as ID by fetching all and finding match
        const allResponse = await contentfulClient.getEntries({
          content_type: 'journal',
          include: 10,
          limit: 1000,
        })
        contentfulJournal = allResponse.items.find(j => j.sys.id === journalIdOrSlug)
        response = allResponse // Use this response for includes
      } else {
        contentfulJournal = response.items[0]
      }
    } else {
      // Default: fetch first journal
      response = await contentfulClient.getEntries({
        content_type: 'journal',
        include: 10,
        limit: 1,
      })
      contentfulJournal = response.items[0]
    }

    if (!contentfulJournal) {
      console.error(`❌ Journal not found: ${journalIdOrSlug || '(first journal)'}`)
      return
    }

    const fields = contentfulJournal.fields

    console.log(`   Title: ${fields.title}`)
    console.log(`   Slug: ${fields.slug}`)
    console.log(`   Has body field: ${!!fields.body}`)
    
    // Check featuredImage - it might be a Link that needs to be resolved
    const hasFeaturedImage = fields.featuredImage && (
      fields.featuredImage.sys?.type === 'Asset' || 
      fields.featuredImage.sys?.type === 'Link' ||
      fields.featuredImage.fields
    )
    console.log(`   Has featuredImage: ${hasFeaturedImage}`)
    console.log(`   Has thumbnailImage: ${!!fields.thumbnailImage}`)
    console.log('')

    // Step 2: Extract embedded assets from Rich Text body
    console.log('📋 Step 2: Extracting embedded images from Rich Text...')
    const assetMap = {} // Map Contentful asset ID -> Contentful asset object
    
    if (fields.body && fields.body.content) {
      // Recursively find all embedded-asset-block nodes
      function findEmbeddedAssets(node) {
        if (!node) return
        
        // Check for embedded-asset-block
        if (node.nodeType === 'embedded-asset-block') {
          const assetId = node.data?.target?.sys?.id
          if (assetId) {
            assetMap[assetId] = null // Placeholder, will be filled from includes
          }
        }
        
        // Recursively check content array
        if (node.content && Array.isArray(node.content)) {
          node.content.forEach(findEmbeddedAssets)
        }
        
        // Also check nested structures (some Contentful formats nest differently)
        if (node.children && Array.isArray(node.children)) {
          node.children.forEach(findEmbeddedAssets)
        }
      }
      
      // Start from document root - always traverse from the root
      if (fields.body.nodeType === 'document') {
        // Document node - traverse its content
        if (fields.body.content) {
          fields.body.content.forEach(findEmbeddedAssets)
        }
        // Also check the document itself
        findEmbeddedAssets(fields.body)
      } else {
        // Not a document node - check if it has content directly
        findEmbeddedAssets(fields.body)
      }
      
      // Resolve assets from includes
      if (response.includes?.Asset) {
        Object.keys(assetMap).forEach(assetId => {
          const asset = response.includes.Asset.find(a => a.sys.id === assetId)
          if (asset) {
            assetMap[assetId] = asset
          } else {
            console.log(`     ⚠️  Embedded asset ${assetId} not found in includes`)
          }
        })
      } else {
        console.log(`     ⚠️  No assets in response.includes`)
      }
    }
    
    const embeddedAssetCount = Object.keys(assetMap).filter(id => assetMap[id] !== null).length
    console.log(`   Found ${embeddedAssetCount} embedded assets in Rich Text`)
    if (embeddedAssetCount > 0) {
      Object.entries(assetMap).forEach(([id, asset]) => {
        if (asset) {
          console.log(`     - ${asset.fields?.file?.fileName || id}`)
        }
      })
    }
    console.log('')

    // Step 3: Upload all embedded images from Rich Text (with retry logic and progressive delays)
    console.log('📋 Step 3: Uploading embedded images (with retry logic and progressive delays)...')
    const strapiAssetMap = {} // Map Contentful asset ID -> {id, url, fileName}
    const totalEmbeddedImages = Object.keys(assetMap).filter(id => assetMap[id] !== null).length
    let uploadedCount = 0
    let failedCount = 0
    
    for (const [assetId, asset] of Object.entries(assetMap)) {
      if (!asset) {
        console.log(`   ⚠️  Asset ${assetId} not found in includes, skipping...`)
        continue
      }
      
      const fileName = asset.fields?.file?.fileName || `image-${assetId}`
      const fileSizeBytes = asset.fields?.file?.details?.size || 0
      const fileSizeMB = fileSizeBytes / 1024 / 1024
      
      // Check migration timeout before each upload
      checkMigrationTimeout()
      
      const uploadStartTime = Date.now()
      console.log(`\n   📤 [${uploadedCount + failedCount + 1}/${totalEmbeddedImages}] Uploading embedded image: ${fileName} (${fileSizeMB.toFixed(2)}MB)...`)
      const uploadResult = await uploadMediaToStrapi(asset, 'embedded-image')
      const uploadTotalTime = ((Date.now() - uploadStartTime) / 1000).toFixed(1)
      
      if (uploadResult) {
        const strapiMediaId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
        
        // Fetch the media file to get its URL
        try {
          const mediaResponse = await strapiRequest(`/api/upload/files/${strapiMediaId}`)
          const mediaUrl = mediaResponse?.url || ''
          const mediaFileName = mediaResponse?.name || fileName
          
                  strapiAssetMap[assetId] = {
                    id: strapiMediaId,
                    url: mediaUrl,
                    fileName: mediaFileName,
                  }
                  console.log(`   ✅ Upload complete (${uploadTotalTime}s total): ID ${strapiMediaId}`)
                  console.log(`   ✅ URL: ${mediaUrl.substring(0, 80)}...`)
                  uploadedCount++
        } catch (error) {
          console.log(`   ⚠️  Uploaded but failed to get URL: ${error.message.substring(0, 50)}`)
          // Still store the ID, URL will be empty
          strapiAssetMap[assetId] = {
            id: strapiMediaId,
            url: '',
            fileName: fileName,
          }
          uploadedCount++
        }
        
        // Progressive delay: increase delay with each upload to avoid overwhelming server
        // Base delay: 3s for small files, 5s for large files (>5MB)
        // Additional progressive delay: +2s per upload (gives server more recovery time)
        // Cap total delay at 15s to prevent extremely long waits
        const baseDelay = fileSizeMB > 5 ? 5000 : 3000
        const progressiveDelay = Math.min((uploadedCount + failedCount) * 2000, 10000) // +2s per upload, cap at 10s
        const totalDelay = Math.min(baseDelay + progressiveDelay, 15000) // Cap total at 15s
        
        console.log(`   ⏳ Waiting ${(totalDelay/1000).toFixed(1)}s before next upload (progressive delay: ${(progressiveDelay/1000).toFixed(1)}s)...`)
        await sleep(totalDelay)
        
        // Check timeout during delay
        checkMigrationTimeout()
      } else {
        console.log(`   ❌ Upload FAILED after all retries (${uploadTotalTime}s total)`)
        failedCount++
        
        // Still add a delay even on failure to avoid hitting server immediately
        console.log(`   ⏳ Waiting 3s before next upload...`)
        await sleep(3000)
      }
    }
    
    console.log('')
    console.log(`📊 Embedded Images Upload Summary:`)
    console.log(`   Total: ${totalEmbeddedImages}`)
    console.log(`   ✅ Uploaded: ${uploadedCount}`)
    console.log(`   ❌ Failed: ${failedCount}`)
    console.log('')

    // Step 4: Upload featuredImage and thumbnailImage (with retry logic)
    console.log('📋 Step 4: Uploading featured and thumbnail images (with retry logic)...')
    checkMigrationTimeout() // Check timeout before media uploads
    
    let featuredImageId = null
    let thumbnailImageId = null
    
    // Check featuredImage - handle both Asset objects and Link references
    if (fields.featuredImage) {
      let featuredImageAsset = fields.featuredImage
      
      // If it's a Link, resolve from includes
      if (featuredImageAsset.sys && featuredImageAsset.sys.type === 'Link') {
        const linkId = featuredImageAsset.sys.id
        featuredImageAsset = response.includes?.Asset?.find(
          asset => asset.sys.id === linkId
        )
        if (!featuredImageAsset) {
          console.log(`   ⚠️  FeaturedImage Link ${linkId} not found in includes`)
        }
      }
      
      // If it's already an Asset object with fields, use it directly
      if (featuredImageAsset && featuredImageAsset.fields) {
        console.log(`   📤 Uploading featuredImage: ${featuredImageAsset.fields.file?.fileName || 'unknown'}...`)
        const uploadResult = await uploadMediaToStrapi(featuredImageAsset, 'featuredImage')
        if (uploadResult) {
          featuredImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
          const sizeMB = typeof uploadResult === 'object' && uploadResult.sizeMB ? uploadResult.sizeMB : 0
          if (featuredImageId) {
            console.log(`   ✅ Uploaded featuredImage successfully (ID: ${featuredImageId}, ${sizeMB.toFixed(2)}MB)`)
            // Delay after large files - increased to avoid overwhelming Strapi Cloud
            if (sizeMB > 5) {
              const delaySeconds = (5000 + sizeMB * 1500) / 1000
              console.log(`   ⏳ Waiting ${delaySeconds.toFixed(1)}s after large file...`)
              await sleep(5000 + (sizeMB * 1500))
            } else {
              await sleep(3000) // Increased from 2s to 3s
            }
          }
        } else {
          console.log(`   ❌ FeaturedImage upload failed after all retries`)
        }
      }
    }

    if (fields.thumbnailImage) {
      let thumbnailImageAsset = fields.thumbnailImage
      if (thumbnailImageAsset.sys && thumbnailImageAsset.sys.type === 'Link') {
        thumbnailImageAsset = response.includes?.Asset?.find(
          asset => asset.sys.id === thumbnailImageAsset.sys.id
        )
      }
      if (thumbnailImageAsset && thumbnailImageAsset.fields) {
        console.log(`   📤 Uploading thumbnailImage: ${thumbnailImageAsset.fields.file?.fileName || 'unknown'}...`)
        const uploadResult = await uploadMediaToStrapi(thumbnailImageAsset, 'thumbnailImage')
        if (uploadResult) {
          thumbnailImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
          const sizeMB = typeof uploadResult === 'object' && uploadResult.sizeMB ? uploadResult.sizeMB : 0
          if (thumbnailImageId) {
            console.log(`   ✅ Uploaded thumbnailImage successfully (ID: ${thumbnailImageId}, ${sizeMB.toFixed(2)}MB)`)
            // Delay after large files - increased to avoid overwhelming Strapi Cloud
            if (sizeMB > 5) {
              const delaySeconds = (5000 + sizeMB * 1500) / 1000
              console.log(`   ⏳ Waiting ${delaySeconds.toFixed(1)}s after large file...`)
              await sleep(5000 + (sizeMB * 1500))
            } else {
              await sleep(3000) // Increased from 2s to 3s
            }
          }
        } else {
          console.log(`   ❌ ThumbnailImage upload failed after all retries`)
        }
      }
    }
    console.log('')

    // Step 5: Verify all embedded images were uploaded
    checkMigrationTimeout() // Check timeout before verification
    console.log('📋 Step 5: Verifying embedded images upload...')
    const expectedEmbeddedCount = Object.keys(assetMap).filter(id => assetMap[id] !== null).length
    const uploadedEmbeddedCount = Object.keys(strapiAssetMap).length
    
    if (expectedEmbeddedCount > 0) {
      console.log(`   Expected embedded images: ${expectedEmbeddedCount}`)
      console.log(`   Successfully uploaded: ${uploadedEmbeddedCount}`)
      
      if (uploadedEmbeddedCount < expectedEmbeddedCount) {
        const missing = expectedEmbeddedCount - uploadedEmbeddedCount
        console.log(`   ❌ MISSING ${missing} embedded image(s)!`)
        console.log(`   ⚠️  Cannot proceed - all embedded images must be uploaded`)
        
        // List which ones are missing
        const missingAssets = []
        Object.keys(assetMap).forEach(assetId => {
          if (assetMap[assetId] && !strapiAssetMap[assetId]) {
            const asset = assetMap[assetId]
            missingAssets.push(asset.fields?.file?.fileName || assetId)
          }
        })
        
        if (missingAssets.length > 0) {
          console.log(`   Missing images:`)
          missingAssets.forEach(name => console.log(`     - ${name}`))
        }
        
        throw new Error(`Failed to upload all embedded images. ${missing} of ${expectedEmbeddedCount} images failed.`)
      } else {
        console.log(`   ✅ All embedded images uploaded successfully!`)
      }
    } else {
      console.log(`   ℹ️  No embedded images to verify`)
    }
    console.log('')

    // Step 6: Convert Rich Text from Contentful to Strapi Markdown format
    console.log('📋 Step 6: Converting Rich Text to Markdown format...')
    const markdownBody = convertContentfulRichTextToStrapi(fields.body, strapiAssetMap)
    console.log(`   Converted to Markdown (${markdownBody.length} characters)`)
    
    // Count embedded images in the markdown (lines starting with ![])
    const imageCount = (markdownBody.match(/!\[.*?\]\(.*?\)/g) || []).length
    console.log(`   Embedded images in markdown: ${imageCount}`)
    console.log(`   Preview (first 200 chars): ${markdownBody.substring(0, 200)}...`)
    console.log('')

    // Step 7: Check if entry already exists
    const targetSlug = (fields.slug || `journal-${contentfulJournal.sys.id}`).trim() // Trim whitespace from slug
    console.log('📋 Step 7: Checking if entry already exists...')
    try {
      const existing = await getStrapiEntries('journals', { filters: { slug: { $eq: targetSlug } } })
      if (existing && existing.length > 0) {
        console.log(`   ⚠️  Entry with slug "${targetSlug}" already exists (ID: ${existing[0].id})`)
        console.log('   ℹ️  Skipping migration - entry already exists')
        return {
          skipped: true,
          existing: true,
          slug: targetSlug,
          entryId: existing[0].id,
        }
      }
      console.log('   ✅ No existing entry found, proceeding...')
    } catch (e) {
      // Ignore errors, proceed with creation
      console.log('   ℹ️  Could not check for existing entry, proceeding...')
    }
    console.log('')

    // Step 8: Create journal entry
    console.log('📋 Step 8: Creating journal (magazine post) entry...')
    const strapiData = {
      title: mapText(fields.title),
      slug: targetSlug,
      titleColor: mapText(fields.titleColor),
      comingSoon: mapBoolean(fields.comingSoon),
      body: markdownBody, // Strapi richtext expects Markdown text
      introduction: mapText(fields.introduction),
      featuredStory: mapBoolean(fields.featuredStory),
      // Media will be attached separately
    }

    console.log('   Entry data preview:')
    console.log(`     Title: ${strapiData.title}`)
    console.log(`     Slug: ${strapiData.slug}`)
    console.log(`     Body (markdown): ${markdownBody.length} characters`)
    console.log(`     Has featuredImage: ${!!featuredImageId}`)
    console.log(`     Has thumbnailImage: ${!!thumbnailImageId}`)
    console.log(`     Embedded images in body: ${imageCount}`)

    const strapiEntry = await createStrapiEntry('journals', strapiData)
    console.log(`   ✅ Created magazine post entry (ID: ${strapiEntry.id}, documentId: ${strapiEntry.documentId})`)
    console.log('')

    // Step 9: Attach media separately
    const entryId = strapiEntry.documentId || strapiEntry.id
    const updateData = {}
    
    if (featuredImageId) {
      updateData.featuredImage = featuredImageId
    }
    if (thumbnailImageId) {
      updateData.thumbnailImage = thumbnailImageId
    }

    if (Object.keys(updateData).length > 0) {
      console.log('📋 Step 9: Attaching media to entry...')
      try {
        await strapiRequest(`/api/journals/${entryId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: updateData }),
        })
        console.log(`   ✅ Successfully attached media`)
      } catch (error) {
        console.log(`   ⚠️  Failed to attach media: ${error.message.substring(0, 100)}`)
      }
    } else {
      console.log('📋 Step 8: No media to attach')
    }
    console.log('')

    // Summary
    console.log('✅ Test completed successfully!')
    console.log('\n📊 Summary:')
    console.log(`   Title: ${fields.title}`)
    console.log(`   Entry ID: ${strapiEntry.id}`)
    console.log(`   Entry Document ID: ${strapiEntry.documentId}`)
    console.log(`   Slug: ${targetSlug}`)
    console.log(`   Featured Image: ${featuredImageId ? `✅ (ID: ${featuredImageId})` : '❌'}`)
    console.log(`   Thumbnail Image: ${thumbnailImageId ? `✅ (ID: ${thumbnailImageId})` : '❌'}`)
    console.log(`   Embedded Images: ${imageCount} in markdown body`)
    console.log(`   Body (Markdown): ${markdownBody.length} characters`)
    console.log('\n💡 You can now check the entry in Strapi admin panel to verify:')
    console.log(`   - Body field shows Markdown text (WYSIWYG) instead of JSON`)
    console.log(`   - Embedded images appear as markdown: ![filename](url)`)
    console.log(`   - Featured and thumbnail images are attached`)
    console.log('')

  } catch (error) {
    console.error('\n❌ Test failed:', error)
    console.error('   Stack:', error.stack)
    throw error
  }
}

// Run if called directly
if (require.main === module) {
  const journalIdOrSlug = process.argv[2] || null
  if (journalIdOrSlug) {
    console.log(`📌 Target journal: ${journalIdOrSlug}\n`)
  } else {
    console.log('ℹ️  No journal ID/slug provided, will fetch first journal\n')
  }
  
  createMagazinePost(journalIdOrSlug)
    .then((result) => {
      if (result && result.skipped) {
        console.log('✅ Entry already exists, skipped')
        process.exit(0)
      } else {
        console.log('✅ Migration completed')
        process.exit(0)
      }
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = createMagazinePost

