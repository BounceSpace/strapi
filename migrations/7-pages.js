/**
 * Migration 4.7: Pages
 * 
 * Migrates Pages from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * - buttonLink (Text -> Short text)
 * - buttonText (Text -> Short text)
 * - heroImage (Media -> Media field, single)
 * - video (Media -> Media field, single)
 * - content (Rich Text -> Rich Text Blocks)
 * 
 * Execution sequence: 4.7
 * Media: heroImage, video (uploaded as part of entry creation)
 */

const {
  contentfulClient,
  createStrapiEntry,
  uploadMediaToStrapi,
  mapText,
  mapRichText,
  sleep,
} = require('./utils')

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

        // Upload media files first
        console.log('  📤 Uploading media files...')
        const heroImageId = await uploadMediaToStrapi(fields.heroImage, 'heroImage')
        const videoId = await uploadMediaToStrapi(fields.video, 'video')

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          buttonLink: mapText(fields.buttonLink),
          buttonText: mapText(fields.buttonText),
          heroImage: heroImageId, // Single media relation ID
          video: videoId, // Single media relation ID
          content: mapRichText(fields.content), // Rich Text Blocks
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('pages', strapiData)

        // Store ID mapping
        idMapping.set(contentfulPage.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < pages.length - 1) {
          await sleep(1500) // 1.5 second delay for media uploads
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

