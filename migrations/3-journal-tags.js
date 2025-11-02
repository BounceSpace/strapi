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
  getStrapiEntries,
  mapText,
  sleep,
} = require('./utils')

async function migrateJournalTags() {
  console.log('\n🚀 Starting JournalTags -> Magazine Tags migration (4.3)...\n')

  try {
    // Step 1: Check if content type exists
    console.log('📋 Step 1: Checking content type...')
    const pluralName = 'journaltags'
    
    // Check if content type exists in Strapi (via API)
    // Try to fetch entries from the REST API to verify it exists
    try {
      await getStrapiEntries(pluralName, { _limit: 1 })
      console.log(`✅ Content type "${pluralName}" exists and is accessible in Strapi API`)
    } catch (error) {
      console.log(`⚠️  Content type "${pluralName}" not found or not accessible in Strapi API`)
      console.log('   Please ensure the content type is deployed and REST API is enabled.')
      console.log('   Then run this migration again.')
      throw new Error(`Content type "${pluralName}" not found in Strapi. Please deploy content types first.`)
    }
    
    console.log('   Proceeding to entry migration...')
    console.log('')
    
    // Step 2: Migrate entries
    console.log('📋 Step 2: Migrating entries from Contentful...')
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
        const tagTitle = fields.tagTitle || 'Untitled'
        const title = tagTitle.trim() // Use tagTitle as title in Strapi
        console.log(`\n[${i + 1}/${journalTags.length}] Processing: ${title}`)

        // Map fields according to field mapping rules
        // Contentful has tagTitle and slug, but Strapi expects tagTitle, title, and slug
        const strapiData = {
          tagTitle: mapText(tagTitle),
          title: mapText(title),
          slug: mapText(fields.slug),
        }

        // Create entry in Strapi (journaltags is the plural name, renamed to "Magazine Tags" in display name)
        const strapiEntry = await createStrapiEntry('journaltags', strapiData)

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

