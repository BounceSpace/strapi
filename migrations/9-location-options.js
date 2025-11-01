/**
 * Migration 4.9: LocationOptions
 * 
 * Migrates LocationOptions from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - priceText (Text -> Short text)
 * - description (Text -> Long text)
 * - bookingUrl (Text -> Short text)
 * - optixPlanId (Text -> Short text)
 * - optixProductId (Text -> Short text)
 * 
 * Execution sequence: 4.9
 */

const {
  contentfulClient,
  createStrapiEntry,
  mapText,
  sleep,
} = require('./utils')

async function migrateLocationOptions() {
  console.log('\n🚀 Starting LocationOptions migration (4.9)...\n')

  try {
    // Fetch all LocationOptions from Contentful
    console.log('📥 Fetching LocationOptions from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'locationOption',
      include: 2,
    })

    const locationOptions = response.items
    console.log(`Found ${locationOptions.length} LocationOptions in Contentful\n`)

    if (locationOptions.length === 0) {
      console.log('⚠️  No LocationOptions found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each LocationOption
    for (let i = 0; i < locationOptions.length; i++) {
      const contentfulOption = locationOptions[i]
      const fields = contentfulOption.fields

      try {
        console.log(`\n[${i + 1}/${locationOptions.length}] Processing: ${fields.title || 'Untitled'}`)

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          priceText: mapText(fields.priceText),
          description: mapText(fields.description),
          bookingUrl: mapText(fields.bookingUrl),
          optixPlanId: mapText(fields.optixPlanId),
          optixProductId: mapText(fields.optixProductId),
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('location-options', strapiData)

        // Store ID mapping
        idMapping.set(contentfulOption.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < locationOptions.length - 1) {
          await sleep(500) // 500ms delay
        }
      } catch (error) {
        console.error(`❌ Error migrating LocationOption "${fields.title || contentfulOption.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ LocationOptions migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${locationOptions.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in LocationOptions migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateLocationOptions()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateLocationOptions

