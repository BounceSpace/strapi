/**
 * Migration 4.2: LocationTags
 * 
 * Migrates LocationTags from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * 
 * Execution sequence: 4.2
 */

const {
  contentfulClient,
  createStrapiEntry,
  mapText,
  sleep,
} = require('./utils')

async function migrateLocationTags() {
  console.log('\n🚀 Starting LocationTags migration (4.2)...\n')

  try {
    // Fetch all LocationTags from Contentful
    console.log('📥 Fetching LocationTags from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'locationTag',
      include: 2,
    })

    const locationTags = response.items
    console.log(`Found ${locationTags.length} LocationTags in Contentful\n`)

    if (locationTags.length === 0) {
      console.log('⚠️  No LocationTags found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each LocationTag
    for (let i = 0; i < locationTags.length; i++) {
      const contentfulTag = locationTags[i]
      const fields = contentfulTag.fields

      try {
        console.log(`\n[${i + 1}/${locationTags.length}] Processing: ${fields.title || 'Untitled'}`)

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('location-tags', strapiData)

        // Store ID mapping
        idMapping.set(contentfulTag.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < locationTags.length - 1) {
          await sleep(500) // 500ms delay
        }
      } catch (error) {
        console.error(`❌ Error migrating LocationTag "${fields.title || contentfulTag.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ LocationTags migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${locationTags.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in LocationTags migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateLocationTags()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateLocationTags

