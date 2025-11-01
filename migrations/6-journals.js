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
  uploadMediaToStrapi,
  mapText,
  mapRichText,
  mapBoolean,
  mapReference,
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
        console.log(`\n[${i + 1}/${journals.length}] Processing: ${fields.title || 'Untitled'}`)

        // Upload media files first
        console.log('  📤 Uploading media files...')
        const featuredImageId = await uploadMediaToStrapi(fields.featuredImage, 'featuredImage')
        const thumbnailImageId = await uploadMediaToStrapi(fields.thumbnailImage, 'thumbnailImage')

        // Map tags references
        const tagsIds = mapReference(fields.tags, tagsIdMapping)

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          titleColor: mapText(fields.titleColor),
          comingSoon: mapBoolean(fields.comingSoon),
          featuredImage: featuredImageId, // Single media relation ID
          thumbnailImage: thumbnailImageId, // Single media relation ID
          body: mapRichText(fields.body), // Rich Text Blocks
          introduction: mapText(fields.introduction),
          tags: tagsIds, // Array of relation IDs to Magazine Tags
          featuredStory: mapBoolean(fields.featuredStory),
        }

        // Create entry in Strapi as "magazine-posts" (renamed from journals)
        const strapiEntry = await createStrapiEntry('magazine-posts', strapiData)

        // Store ID mapping
        idMapping.set(contentfulJournal.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < journals.length - 1) {
          await sleep(1500) // 1.5 second delay for multiple media uploads
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

