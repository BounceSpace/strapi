/**
 * Migration 4.3: JournalTags -> Magazine Tags
 * 
 * Migrates JournalTags from Contentful to Strapi
 * Renamed to "Magazine Tags" in Strapi
 * 
 * Fields:
 * - tagTitle (Text -> Short text)
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * 
 * Execution sequence: 4.3
 */

const {
  contentfulClient,
  createStrapiEntry,
  mapText,
  sleep,
} = require('./utils')

async function migrateJournalTags() {
  console.log('\n🚀 Starting JournalTags -> Magazine Tags migration (4.3)...\n')

  try {
    // Fetch all JournalTags from Contentful
    console.log('📥 Fetching JournalTags from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'journalTag',
      include: 2,
    })

    const journalTags = response.items
    console.log(`Found ${journalTags.length} JournalTags in Contentful\n`)

    if (journalTags.length === 0) {
      console.log('⚠️  No JournalTags found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each JournalTag to Magazine Tag
    for (let i = 0; i < journalTags.length; i++) {
      const contentfulTag = journalTags[i]
      const fields = contentfulTag.fields

      try {
        console.log(`\n[${i + 1}/${journalTags.length}] Processing: ${fields.title || fields.tagTitle || 'Untitled'}`)

        // Map fields according to field mapping rules
        const strapiData = {
          tagTitle: mapText(fields.tagTitle),
          title: mapText(fields.title),
          slug: mapText(fields.slug),
        }

        // Create entry in Strapi as "magazine-tags" (renamed from journal-tags)
        const strapiEntry = await createStrapiEntry('magazine-tags', strapiData)

        // Store ID mapping
        idMapping.set(contentfulTag.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < journalTags.length - 1) {
          await sleep(500) // 500ms delay
        }
      } catch (error) {
        console.error(`❌ Error migrating JournalTag "${fields.title || contentfulTag.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ JournalTags -> Magazine Tags migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${journalTags.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in JournalTags migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateJournalTags()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateJournalTags

