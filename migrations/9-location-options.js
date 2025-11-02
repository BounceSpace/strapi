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
  getStrapiEntries,
  strapiRequest,
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

        // Check if entry already exists (by title since there's no slug)
        try {
          const existing = await getStrapiEntries('locationoption', { 
            filters: { title: { $eq: strapiData.title } } 
          })
          if (existing && existing.length > 0) {
            console.log(`   ⚠️  Entry with title "${strapiData.title}" already exists (ID: ${existing[0].id})`)
            console.log('   ℹ️  Skipping migration - entry already exists')
            idMapping.set(contentfulOption.sys.id, existing[0].id)
            successCount++
            continue
          }
        } catch (e) {
          // Ignore errors, proceed with creation
        }

        // Create entry in Strapi
        console.log('   📋 Creating location option entry...')
        let strapiEntry = null
        
        // Try Content Manager API first
        try {
          const createResponse = await strapiRequest('/api/content-manager/collection-types/api::locationoption.locationoption', {
            method: 'POST',
            body: JSON.stringify(strapiData),
          })
          strapiEntry = createResponse
        } catch (cmError) {
          // Fall back to REST API
          try {
            const createResponse = await strapiRequest('/api/locationoptions', {
              method: 'POST',
              body: JSON.stringify({ data: strapiData }),
            })
            strapiEntry = createResponse.data || createResponse
          } catch (restError) {
            throw new Error(`Failed to create entry: ${restError.message}`)
          }
        }

        // Store ID mapping
        idMapping.set(contentfulOption.sys.id, strapiEntry.id || strapiEntry.documentId)
        successCount++
        console.log(`   ✅ Successfully migrated location option: ${fields.title}`)

        // Rate limiting - wait a bit between requests
        if (i < locationOptions.length - 1) {
          await sleep(1000) // 1 second delay
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
