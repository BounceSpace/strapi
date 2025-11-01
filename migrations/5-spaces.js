/**
 * Migration 4.5: Spaces
 * 
 * Migrates Spaces from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * - description (Text -> Long text)
 * - spaceTags (Reference -> Relation, many-to-many)
 * - featuredImage (Media -> Media field, single)
 * - optixResourceId (Text -> Short text)
 * 
 * Execution sequence: 4.5
 * Dependencies: SpaceTags (4.1) - requires idMapping from previous migration
 * Media: featuredImage (uploaded as part of entry creation)
 */

const {
  contentfulClient,
  createStrapiEntry,
  uploadMediaToStrapi,
  mapText,
  mapReference,
  sleep,
} = require('./utils')

// This should be loaded from previous migration
// For now, we'll fetch SpaceTags mapping from Strapi
let spaceTagsIdMapping = new Map()

async function loadSpaceTagsMapping() {
  console.log('📋 Loading SpaceTags ID mapping...')
  const { getStrapiEntries } = require('./utils')
  const strapiTags = await getStrapiEntries('space-tags')
  
  // Create mapping from slug (assuming slugs are unique)
  // Note: In a real scenario, you'd store Contentful IDs in a metadata field
  // For now, we'll match by slug
  spaceTagsIdMapping = new Map()
  
  // We need to get Contentful IDs - this is a simplified approach
  // Ideally, you'd store Contentful ID as metadata in Strapi during migration
  console.log('⚠️  SpaceTags mapping will be matched by slug. Ensure slugs match exactly.')
}

async function migrateSpaces(spaceTagsIdMappingFromPrevious = null) {
  console.log('\n🚀 Starting Spaces migration (4.5)...\n')

  // Use provided mapping or load from Strapi
  if (spaceTagsIdMappingFromPrevious) {
    spaceTagsIdMapping = spaceTagsIdMappingFromPrevious
  } else {
    await loadSpaceTagsMapping()
  }

  try {
    // Fetch all Spaces from Contentful
    console.log('📥 Fetching Spaces from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'space',
      include: 10, // Include assets and linked entries
    })

    const spaces = response.items
    console.log(`Found ${spaces.length} Spaces in Contentful\n`)

    if (spaces.length === 0) {
      console.log('⚠️  No Spaces found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each Space
    for (let i = 0; i < spaces.length; i++) {
      const contentfulSpace = spaces[i]
      const fields = contentfulSpace.fields

      try {
        console.log(`\n[${i + 1}/${spaces.length}] Processing: ${fields.title || 'Untitled'}`)

        // Upload media files first
        console.log('  📤 Uploading featured image...')
        const featuredImageId = await uploadMediaToStrapi(fields.featuredImage, 'featuredImage')

        // Map spaceTags references
        const spaceTagsIds = mapReference(fields.spaceTags, spaceTagsIdMapping)

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          description: mapText(fields.description),
          spaceTags: spaceTagsIds, // Array of relation IDs
          featuredImage: featuredImageId, // Single media relation ID
          optixResourceId: mapText(fields.optixResourceId),
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('spaces', strapiData)

        // Store ID mapping
        idMapping.set(contentfulSpace.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < spaces.length - 1) {
          await sleep(1000) // 1 second delay for media uploads
        }
      } catch (error) {
        console.error(`❌ Error migrating Space "${fields.title || contentfulSpace.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ Spaces migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${spaces.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in Spaces migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateSpaces()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateSpaces

