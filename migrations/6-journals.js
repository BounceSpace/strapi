/**
 * Migration 4.6: Journals -> Magazine Posts
 * 
 * Migrates Journals from Contentful to Strapi
 * Renamed to "Magazine Posts" in Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * - titleColor (Text -> Short text/Select)
 * - comingSoon (Boolean -> Boolean)
 * - featuredImage (Media -> Media field, single)
 * - thumbnailImage (Media -> Media field, single)
 * - body (Rich Text -> Rich Text Blocks)
 * - introduction (Text -> Long text)
 * - tags (Reference -> Relation, many-to-many, to Magazine Tags)
 * - featuredStory (Boolean -> Boolean)
 * 
 * Execution sequence: 4.6
 * Dependencies: JournalTags/Magazine Tags (4.3) - requires idMapping
 * Media: featuredImage, thumbnailImage (uploaded as part of entry creation)
 */

const {
  contentfulClient,
  createStrapiEntry,
  getStrapiEntries,
  uploadMediaToStrapi,
  strapiRequest,
  updateStrapiEntry,
  mapText,
  mapBoolean,
  mapReference,
  convertContentfulRichTextToStrapi,
  sleep,
} = require('./utils')

async function migrateJournals(magazineTagsIdMapping = null) {
  console.log('\n🚀 Starting Journals -> Magazine Posts migration (4.6)...\n')

  // ID mapping for Magazine Tags (from JournalTags migration)
  let tagsIdMapping = magazineTagsIdMapping || new Map()

  if (!tagsIdMapping || tagsIdMapping.size === 0) {
    console.log('⚠️  No Magazine Tags ID mapping provided. Relations may fail.')
    console.log('    Ensure Magazine Tags migration (4.3) completed successfully.')
  }

  try {
    // Fetch all Journals from Contentful
    console.log('📥 Fetching Journals from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'journal',
      include: 10, // Include assets and linked entries
    })

    const journals = response.items
    console.log(`Found ${journals.length} Journals in Contentful\n`)

    if (journals.length === 0) {
      console.log('⚠️  No Journals found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each Journal to Magazine Post
    for (let i = 0; i < journals.length; i++) {
      const contentfulJournal = journals[i]
      const fields = contentfulJournal.fields

      try {
        const journalTitle = fields.title || 'Untitled'
        console.log(`\n[${i + 1}/${journals.length}] Processing: ${journalTitle}`)

        // Step 1: Extract embedded assets from Rich Text body
        console.log('  📋 Step 1: Extracting embedded images from Rich Text...')
        const assetMap = {} // Map Contentful asset ID -> Contentful asset object
        
        if (fields.body && fields.body.content) {
          // Recursively find all embedded-asset-block nodes
          function findEmbeddedAssets(node) {
            if (node.nodeType === 'embedded-asset-block') {
              const assetId = node.data?.target?.sys?.id
              if (assetId) {
                assetMap[assetId] = null // Placeholder, will be filled from includes
              }
            }
            if (node.content && Array.isArray(node.content)) {
              node.content.forEach(findEmbeddedAssets)
            }
          }
          findEmbeddedAssets(fields.body)
          
          // Resolve assets from includes
          if (response.includes?.Asset) {
            Object.keys(assetMap).forEach(assetId => {
              const asset = response.includes.Asset.find(a => a.sys.id === assetId)
              if (asset) {
                assetMap[assetId] = asset
              }
            })
          }
        }
        
        const embeddedAssetCount = Object.keys(assetMap).filter(id => assetMap[id] !== null).length
        console.log(`     Found ${embeddedAssetCount} embedded assets in Rich Text`)

        // Step 2: Upload all embedded images from Rich Text (with retry logic)
        console.log('  📋 Step 2: Uploading embedded images...')
        const strapiAssetMap = {} // Map Contentful asset ID -> {id, url, fileName}
        
        for (const [assetId, asset] of Object.entries(assetMap)) {
          if (!asset) {
            console.log(`     ⚠️  Asset ${assetId} not found in includes, skipping...`)
            continue
          }
          
          const fileName = asset.fields?.file?.fileName || `image-${assetId}`
          console.log(`     Uploading embedded image: ${fileName}...`)
          const uploadResult = await uploadMediaToStrapi(asset, 'embedded-image')
          
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
              console.log(`     ✅ Uploaded (ID: ${strapiMediaId})`)
            } catch (error) {
              console.log(`     ⚠️  Uploaded but failed to get URL: ${error.message.substring(0, 50)}`)
              // Still store the ID, URL will be empty
              strapiAssetMap[assetId] = {
                id: strapiMediaId,
                url: '',
                fileName: fileName,
              }
            }
            
            // Add delay between embedded image uploads
            await sleep(2000) // 2 second delay
          }
        }

        // Step 3: Upload featuredImage and thumbnailImage (with retry logic)
        console.log('  📋 Step 3: Uploading featured and thumbnail images...')
        let featuredImageId = null
        let thumbnailImageId = null
        
        if (fields.featuredImage) {
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
                console.log(`     ✅ Uploaded featuredImage (ID: ${featuredImageId})`)
                // Delay after large files
                if (sizeMB > 5) {
                  await sleep(3000 + (sizeMB * 1000))
                } else {
                  await sleep(2000)
                }
              }
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
            const uploadResult = await uploadMediaToStrapi(thumbnailImageAsset, 'thumbnailImage')
            if (uploadResult) {
              thumbnailImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
              const sizeMB = typeof uploadResult === 'object' && uploadResult.sizeMB ? uploadResult.sizeMB : 0
              if (thumbnailImageId) {
                console.log(`     ✅ Uploaded thumbnailImage (ID: ${thumbnailImageId})`)
                // Delay after large files
                if (sizeMB > 5) {
                  await sleep(3000 + (sizeMB * 1000))
                } else {
                  await sleep(2000)
                }
              }
            }
          }
        }

        // Step 4: Convert Rich Text from Contentful to Strapi Markdown format
        console.log('  📋 Step 4: Converting Rich Text to Markdown format...')
        const markdownBody = convertContentfulRichTextToStrapi(fields.body, strapiAssetMap)
        console.log(`     Converted to Markdown (${markdownBody.length} characters)`)

        // Step 5: Map tags references
        const tagsIds = mapReference(fields.tags, tagsIdMapping)
        if (tagsIds && Array.isArray(tagsIds) && tagsIds.length > 0) {
          console.log(`     Mapped ${tagsIds.length} magazine tags`)
        }

        // Step 6: Check if entry already exists (by slug)
        let strapiEntry
        const existing = await getStrapiEntries('journals', { 
          filters: { slug: { $eq: mapText(fields.slug) } }
        })
        
        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          titleColor: mapText(fields.titleColor),
          comingSoon: mapBoolean(fields.comingSoon),
          body: markdownBody, // Strapi richtext expects Markdown text
          introduction: mapText(fields.introduction),
          featuredStory: mapBoolean(fields.featuredStory),
          // Media and relations will be attached separately
        }

        if (existing && existing.length > 0) {
          console.log(`     ⚠️  Entry with slug "${mapText(fields.slug)}" already exists. Updating...`)
          const entryId = existing[0].documentId || existing[0].id
          
          // Update entry
          const updateResponse = await strapiRequest(`/api/journals/${entryId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: strapiData }),
          })
          strapiEntry = updateResponse.data || existing[0]
          console.log(`     ✅ Updated existing entry (ID: ${strapiEntry.id})`)
        } else {
          // Create entry in Strapi (journals = Magazine Posts)
          console.log('  📋 Step 5: Creating journal entry...')
          strapiEntry = await createStrapiEntry('journals', strapiData)
          console.log(`     ✅ Created entry (ID: ${strapiEntry.id}, documentId: ${strapiEntry.documentId})`)
        }

        // Step 7: Attach media and relations separately
        const entryId = strapiEntry.documentId || strapiEntry.id
        const updateData = {}
        
        if (featuredImageId) {
          updateData.featuredImage = featuredImageId
        }
        if (thumbnailImageId) {
          updateData.thumbnailImage = thumbnailImageId
        }
        
        // Set tags relations using connect syntax (Strapi v5 requires documentIds)
        if (tagsIds && Array.isArray(tagsIds) && tagsIds.length > 0) {
          updateData.tags = {
            connect: tagsIds // Array of documentIds
          }
        }

        if (Object.keys(updateData).length > 0) {
          console.log('  📋 Step 6: Attaching media and relations...')
          try {
            await strapiRequest(`/api/journals/${entryId}`, {
              method: 'PUT',
              body: JSON.stringify({ data: updateData }),
            })
            console.log(`     ✅ Attached media and relations`)
          } catch (error) {
            console.log(`     ⚠️  Failed to attach media/relations: ${error.message.substring(0, 100)}`)
          }
        }

        // Store ID mapping
        idMapping.set(contentfulJournal.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < journals.length - 1) {
          await sleep(2000) // 2 second delay between entries
        }
      } catch (error) {
        console.error(`❌ Error migrating Journal "${fields.title || contentfulJournal.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ Journals -> Magazine Posts migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${journals.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in Journals migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateJournals()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateJournals

