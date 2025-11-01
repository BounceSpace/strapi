/**
 * Migration 4.8: Events
 * 
 * Migrates Events from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - subtitle (Text -> Short text)
 * - slug (Text -> Short text)
 * - startTime (Date & Time -> DateTime)
 * - endTime (Date & Time -> DateTime)
 * - destinationUrl (Text -> Short text)
 * - summary (Text -> Long text)
 * 
 * Execution sequence: 4.8
 */

const {
  contentfulClient,
  createStrapiEntry,
  mapText,
  mapDate,
  sleep,
} = require('./utils')

async function migrateEvents() {
  console.log('\n🚀 Starting Events migration (4.8)...\n')

  try {
    // Fetch all Events from Contentful
    console.log('📥 Fetching Events from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'event',
      include: 2,
    })

    const events = response.items
    console.log(`Found ${events.length} Events in Contentful\n`)

    if (events.length === 0) {
      console.log('⚠️  No Events found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each Event
    for (let i = 0; i < events.length; i++) {
      const contentfulEvent = events[i]
      const fields = contentfulEvent.fields

      try {
        console.log(`\n[${i + 1}/${events.length}] Processing: ${fields.title || 'Untitled'}`)

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          subtitle: mapText(fields.subtitle),
          slug: mapText(fields.slug),
          startTime: mapDate(fields.startTime), // DateTime
          endTime: mapDate(fields.endTime), // DateTime
          destinationUrl: mapText(fields.destinationUrl),
          summary: mapText(fields.summary),
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('events', strapiData)

        // Store ID mapping
        idMapping.set(contentfulEvent.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < events.length - 1) {
          await sleep(500) // 500ms delay
        }
      } catch (error) {
        console.error(`❌ Error migrating Event "${fields.title || contentfulEvent.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ Events migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${events.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in Events migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateEvents()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateEvents

