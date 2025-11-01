/**
 * Migration 4.10: Locations
 * 
 * Migrates Locations from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - subtitle (Text -> Short text)
 * - about (Text -> Long text)
 * - slug (Text -> Short text)
 * - locationTags (Reference -> Relation, many-to-many)
 * - featuredImage (Media -> Media field, single)
 * - locationGallery (Media -> Media field, multiple)
 * - locationVideo (Media -> Media field, single)
 * - meetingSpacesDescriptionText (Text -> Long text)
 * - meetingSpacesHeaderText (Text -> Short text)
 * - spaces (Reference -> Relation, many-to-many)
 * - locationOptions (Reference -> Relation, many-to-many)
 * - optionsDescriptionText (Text -> Long text)
 * - bookMeetingSpaceUrl (Text -> Short text)
 * 
 * Execution sequence: 4.10
 * Dependencies:
 *   - LocationTags (4.2) - requires idMapping
 *   - Spaces (4.5) - requires idMapping
 *   - LocationOptions (4.9) - requires idMapping
 * Media: featuredImage, locationGallery (multiple), locationVideo (uploaded as part of entry creation)
 */

const {
  contentfulClient,
  createStrapiEntry,
  uploadMediaToStrapi,
  uploadMultipleMediaToStrapi,
  mapText,
  mapReference,
  sleep,
} = require('./utils')

async function migrateLocations(
  locationTagsIdMapping = null,
  spacesIdMapping = null,
  locationOptionsIdMapping = null
) {
  console.log('\n🚀 Starting Locations migration (4.10)...\n')

  // ID mappings from previous migrations
  let locationTagsMapping = locationTagsIdMapping || new Map()
  let spacesMapping = spacesIdMapping || new Map()
  let locationOptionsMapping = locationOptionsIdMapping || new Map()

  if (!locationTagsMapping || locationTagsMapping.size === 0) {
    console.log('⚠️  No LocationTags ID mapping provided. Relations may fail.')
  }
  if (!spacesMapping || spacesMapping.size === 0) {
    console.log('⚠️  No Spaces ID mapping provided. Relations may fail.')
  }
  if (!locationOptionsMapping || locationOptionsMapping.size === 0) {
    console.log('⚠️  No LocationOptions ID mapping provided. Relations may fail.')
  }

  try {
    // Fetch all Locations from Contentful
    console.log('📥 Fetching Locations from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'location',
      include: 10, // Include assets and linked entries
    })

    const locations = response.items
    console.log(`Found ${locations.length} Locations in Contentful\n`)

    if (locations.length === 0) {
      console.log('⚠️  No Locations found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each Location
    for (let i = 0; i < locations.length; i++) {
      const contentfulLocation = locations[i]
      const fields = contentfulLocation.fields

      try {
        console.log(`\n[${i + 1}/${locations.length}] Processing: ${fields.title || 'Untitled'}`)

        // Upload media files first
        console.log('  📤 Uploading media files...')
        const featuredImageId = await uploadMediaToStrapi(fields.featuredImage, 'featuredImage')
        
        // Handle multiple gallery images
        const galleryImageIds = await uploadMultipleMediaToStrapi(
          fields.locationGallery,
          'locationGallery'
        )
        
        const locationVideoId = await uploadMediaToStrapi(fields.locationVideo, 'locationVideo')

        // Map references
        const locationTagsIds = mapReference(fields.locationTags, locationTagsMapping)
        const spacesIds = mapReference(fields.spaces, spacesMapping)
        const locationOptionsIds = mapReference(fields.locationOptions, locationOptionsMapping)

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          subtitle: mapText(fields.subtitle),
          about: mapText(fields.about),
          slug: mapText(fields.slug),
          locationTags: locationTagsIds, // Array of relation IDs
          featuredImage: featuredImageId, // Single media relation ID
          locationGallery: galleryImageIds, // Array of media relation IDs
          locationVideo: locationVideoId, // Single media relation ID
          meetingSpacesDescriptionText: mapText(fields.meetingSpacesDescriptionText),
          meetingSpacesHeaderText: mapText(fields.meetingSpacesHeaderText),
          spaces: spacesIds, // Array of relation IDs
          locationOptions: locationOptionsIds, // Array of relation IDs
          optionsDescriptionText: mapText(fields.optionsDescriptionText),
          bookMeetingSpaceUrl: mapText(fields.bookMeetingSpaceUrl),
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('locations', strapiData)

        // Store ID mapping
        idMapping.set(contentfulLocation.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < locations.length - 1) {
          await sleep(2000) // 2 second delay for multiple media uploads
        }
      } catch (error) {
        console.error(`❌ Error migrating Location "${fields.title || contentfulLocation.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ Locations migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${locations.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in Locations migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateLocations()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateLocations

