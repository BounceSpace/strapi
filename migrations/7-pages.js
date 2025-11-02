/**
 * Migration 4.7: Pages
 * 
 * Migrates Pages from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> UID)
 * - buttonLink (Text -> Short text)
 * - buttonText (Text -> Short text)
 * - heroImage (Media -> Media field, single) - with compression
 * - video (Media -> Media field, single) - with compression
 * - content (Rich Text -> Rich Text Markdown) - with embedded assets
 * 
 * Execution sequence: 4.7
 * Media: heroImage, video (uploaded with compression), embedded assets in content
 */

const {
  contentfulClient,
  getStrapiEntries,
  strapiRequest,
  uploadMediaToStrapi,
  convertContentfulRichTextToStrapi,
  mapText,
  mapBoolean,
  sleep,
} = require('./utils')

const STRAPI_URL = process.env.STRAPI_URL
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN
const STRAPI_ADMIN_TOKEN = process.env.STRAPI_ADMIN_TOKEN

async function migratePages() {
  console.log('\n🚀 Starting Pages migration (4.7)...\n')

  try {
    // Fetch all Pages from Contentful
    console.log('📥 Fetching Pages from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'page',
      include: 10, // Include assets and linked entries
    })

    const pages = response.items
    console.log(`Found ${pages.length} Pages in Contentful\n`)

    if (pages.length === 0) {
      console.log('⚠️  No Pages found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each Page
    for (let i = 0; i < pages.length; i++) {
      const contentfulPage = pages[i]
      const fields = contentfulPage.fields

      try {
        console.log(`\n[${i + 1}/${pages.length}] Processing: ${fields.title || 'Untitled'}`)
        
        const pageSlug = (fields.slug || `page-${contentfulPage.sys.id}`).trim()
        
        // Check if entry already exists
        try {
          const existing = await getStrapiEntries('pages', { filters: { slug: { $eq: pageSlug } } })
          if (existing && existing.length > 0) {
            console.log(`   ⚠️  Entry with slug "${pageSlug}" already exists (ID: ${existing[0].id})`)
            console.log('   ℹ️  Skipping migration - entry already exists')
            idMapping.set(contentfulPage.sys.id, existing[0].id)
            successCount++
            continue
          }
        } catch (e) {
          // Ignore errors, proceed with creation
        }

        // Step 1: Extract embedded assets from content rich text
        console.log('   📋 Step 1: Extracting embedded assets from content...')
        const assetMap = {} // Contentful asset ID -> Asset object
        
        if (fields.content && fields.content.nodeType === 'document') {
          function findEmbeddedAssets(node) {
            if (node && typeof node === 'object') {
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
              
              // Also check nested structures
              if (node.children && Array.isArray(node.children)) {
                node.children.forEach(findEmbeddedAssets)
              }
            }
          }
          
          // Start from document root
          if (fields.content.nodeType === 'document') {
            if (fields.content.content) {
              fields.content.content.forEach(findEmbeddedAssets)
            }
            findEmbeddedAssets(fields.content)
          } else {
            findEmbeddedAssets(fields.content)
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
          }
        }
        
        const embeddedAssetCount = Object.keys(assetMap).filter(id => assetMap[id] !== null).length
        console.log(`   Found ${embeddedAssetCount} embedded assets in content`)

        // Step 2: Upload embedded assets from content (if any)
        const strapiAssetMap = {} // Map Contentful asset ID -> {id, url, fileName}
        
        if (embeddedAssetCount > 0) {
          console.log('   📋 Step 2: Uploading embedded assets from content...')
          for (const [assetId, asset] of Object.entries(assetMap)) {
            if (!asset) {
              console.log(`     ⚠️  Asset ${assetId} not found in includes, skipping...`)
              continue
            }
            
            const fileName = asset.fields?.file?.fileName || `image-${assetId}`
            console.log(`     📤 Uploading embedded asset: ${fileName}...`)
            const uploadResult = await uploadMediaToStrapi(asset, 'embedded-asset')
            
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
                
                // Small delay between uploads
                await sleep(2000)
              } catch (error) {
                console.log(`     ⚠️  Uploaded but failed to get URL: ${error.message.substring(0, 50)}`)
                strapiAssetMap[assetId] = {
                  id: strapiMediaId,
                  url: '',
                  fileName: fileName,
                }
              }
            } else {
              console.log(`     ❌ Upload failed for ${fileName}`)
            }
          }
        }

        // Step 3: Upload heroImage (with compression)
        console.log('   📋 Step 3: Uploading heroImage...')
        let heroImageId = null
        
        if (fields.heroImage) {
          let heroImageAsset = fields.heroImage
          
          // If it's a Link, resolve from includes
          if (heroImageAsset.sys && heroImageAsset.sys.type === 'Link') {
            const linkId = heroImageAsset.sys.id
            heroImageAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === linkId
            )
            if (!heroImageAsset) {
              console.log(`     ⚠️  HeroImage Link ${linkId} not found in includes`)
            }
          }
          
          if (heroImageAsset && heroImageAsset.fields) {
            const uploadResult = await uploadMediaToStrapi(heroImageAsset, 'heroImage')
            if (uploadResult) {
              heroImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
              console.log(`     ✅ Uploaded heroImage (ID: ${heroImageId})`)
              await sleep(2000) // Delay after upload
            } else {
              console.log(`     ❌ HeroImage upload failed`)
            }
          }
        } else {
          console.log(`     ℹ️  No heroImage to upload`)
        }

        // Step 4: Upload video (with compression if it's an image, otherwise just upload)
        console.log('   📋 Step 4: Uploading video...')
        let videoId = null
        
        if (fields.video) {
          let videoAsset = fields.video
          
          // If it's a Link, resolve from includes
          if (videoAsset.sys && videoAsset.sys.type === 'Link') {
            const linkId = videoAsset.sys.id
            videoAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === linkId
            )
            if (!videoAsset) {
              console.log(`     ⚠️  Video Link ${linkId} not found in includes`)
            }
          }
          
          if (videoAsset && videoAsset.fields) {
            const uploadResult = await uploadMediaToStrapi(videoAsset, 'video')
            if (uploadResult) {
              videoId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
              console.log(`     ✅ Uploaded video (ID: ${videoId})`)
              await sleep(2000) // Delay after upload
            } else {
              console.log(`     ❌ Video upload failed`)
            }
          }
        } else {
          console.log(`     ℹ️  No video to upload`)
        }

        // Step 5: Convert rich text content to Markdown
        console.log('   📋 Step 5: Converting content to Markdown...')
        const markdownContent = convertContentfulRichTextToStrapi(fields.content, strapiAssetMap)
        console.log(`     Converted to Markdown (${markdownContent.length} characters)`)

        // Step 6: Create entry in Strapi
        console.log('   📋 Step 6: Creating page entry...')
        const strapiData = {
          title: mapText(fields.title),
          slug: pageSlug,
          buttonLink: mapText(fields.buttonLink),
          buttonText: mapText(fields.buttonText),
          content: markdownContent, // Rich Text Markdown
        }

        // Try Content Manager API first
        let strapiEntry = null
        try {
          const createResponse = await strapiRequest('/api/content-manager/collection-types/api::page.page', {
            method: 'POST',
            body: JSON.stringify(strapiData),
          })
          strapiEntry = createResponse
        } catch (cmError) {
          // Fall back to REST API
          try {
            const createResponse = await strapiRequest('/api/pages', {
              method: 'POST',
              body: JSON.stringify({ data: strapiData }),
            })
            strapiEntry = createResponse.data || createResponse
          } catch (restError) {
            throw new Error(`Failed to create entry: ${restError.message}`)
          }
        }

        // Step 7: Attach media to entry
        console.log('   📋 Step 7: Attaching media to entry...')
        
        if (heroImageId || videoId) {
          try {
            const updateData = {}
            
            // For each media field, attach it using the correct format (Strapi v5 uses direct ID)
            if (heroImageId) {
              updateData.heroImage = heroImageId
            }
            if (videoId) {
              updateData.video = videoId
            }
            
            const entryId = strapiEntry.id || strapiEntry.documentId
            const documentId = strapiEntry.documentId || strapiEntry.id
            
            // Try Content Manager API first
            try {
              await strapiRequest(`/api/content-manager/collection-types/api::page.page/${entryId}`, {
                method: 'PUT',
                body: JSON.stringify(updateData),
              })
              console.log(`     ✅ Successfully attached media via Content Manager API`)
            } catch (cmError) {
              // Fall back to REST API
              await strapiRequest(`/api/pages/${documentId || entryId}`, {
                method: 'PUT',
                body: JSON.stringify({ data: updateData }),
              })
              console.log(`     ✅ Successfully attached media via REST API`)
            }
          } catch (error) {
            console.log(`     ⚠️  Failed to attach media: ${error.message.substring(0, 100)}`)
          }
        } else {
          console.log(`     ℹ️  No media to attach`)
        }

        // Store ID mapping
        idMapping.set(contentfulPage.sys.id, strapiEntry.id || strapiEntry.documentId)
        successCount++
        console.log(`   ✅ Successfully migrated page: ${fields.title}`)

        // Rate limiting - wait between entries
        if (i < pages.length - 1) {
          await sleep(2000) // 2 second delay between entries
        }
      } catch (error) {
        console.error(`❌ Error migrating Page "${fields.title || contentfulPage.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ Pages migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${pages.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in Pages migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migratePages()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migratePages
