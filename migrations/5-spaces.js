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
 * Media: featuredImage (uploaded separately, then attached)
 */

const {
  contentfulClient,
  createStrapiEntry,
  getStrapiEntries,
  uploadMediaToStrapi,
  mapText,
  mapReference,
  sleep,
} = require('./utils')

// This should be loaded from previous migration
// For now, we'll fetch SpaceTags mapping from Strapi
let spaceTagsIdMapping = new Map()

async function loadSpaceTagsMapping() {
  console.log('📋 Loading SpaceTags ID mapping from Strapi...')
  const { getStrapiEntries } = require('./utils')
  const strapiTags = await getStrapiEntries('spacetags')
  
  // Create mapping from slug/title to Strapi documentId (required for relations in Strapi v5)
  // We'll match Contentful spaceTags (which are text strings) to Strapi spaceTags by title/slug
  spaceTagsIdMapping = new Map()
  
  for (const tag of strapiTags) {
    // Map by both slug and title (lowercase) to increase match chances
    if (tag.slug) {
      spaceTagsIdMapping.set(tag.slug.toLowerCase(), tag.documentId || tag.id)
    }
    if (tag.title) {
      spaceTagsIdMapping.set(tag.title.toLowerCase(), tag.documentId || tag.id)
    }
  }
  
  console.log(`   Loaded ${strapiTags.length} SpaceTags for mapping`)
  console.log('   SpaceTags will be matched by slug/title with fuzzy matching for variations.\n')
}

async function migrateSpaces(spaceTagsIdMappingFromPrevious = null) {
  console.log('\n🚀 Starting Spaces migration (4.5)...\n')

  // Check if content type exists (try to fetch entries)
  const { getStrapiEntries } = require('./utils')
  try {
    await getStrapiEntries('spaces', { _limit: 1 })
    console.log('✅ Content type "spaces" exists and is accessible in Strapi API')
    console.log('   Proceeding to entry migration...\n')
  } catch (error) {
    console.error('❌ Content type "spaces" does not exist or is not accessible in Strapi API')
    console.error('   Error:', error.message.substring(0, 200))
    return { success: false, count: 0, errors: 0, idMapping: new Map() }
  }

  // Use provided mapping or load from Strapi
  if (spaceTagsIdMappingFromPrevious) {
    spaceTagsIdMapping = spaceTagsIdMappingFromPrevious
  } else {
    await loadSpaceTagsMapping()
  }

  try {
    // Fetch all Spaces from Contentful
    // Note: In Contentful, spaces are stored as "locationSpace" content type
    console.log('📥 Fetching Spaces from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'locationSpace',
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
        const itemTitle = fields.title || 'Untitled'
        console.log(`\n[${i + 1}/${spaces.length}] Processing: ${itemTitle}`)

        // Map spaceTags from Contentful (which are text strings) to Strapi documentIds
        let spaceTagsDocumentIds = null
        if (fields.spaceTags && Array.isArray(fields.spaceTags)) {
          spaceTagsDocumentIds = fields.spaceTags
            .map(tag => {
              // Contentful spaceTags are text strings, match by text value
              const tagText = (typeof tag === 'string' ? tag : tag.toString()).trim()
              const tagKey = tagText.toLowerCase()
              
              // Try exact match first
              let documentId = spaceTagsIdMapping.get(tagKey)
              
              // If no exact match, try normalized matching (handle spaces/hyphens/special chars)
              if (!documentId) {
                // Normalize: replace spaces with hyphens, remove special chars, lowercase
                const normalizedContentful = tagKey.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
                
                // Try to find a match by comparing normalized keys
                for (const [key, value] of spaceTagsIdMapping.entries()) {
                  const normalizedStrapi = key.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
                  
                  // Match if normalized keys are the same, or if one contains the other
                  if (normalizedContentful === normalizedStrapi || 
                      normalizedContentful.includes(normalizedStrapi) ||
                      normalizedStrapi.includes(normalizedContentful)) {
                    documentId = value
                    console.log(`     ℹ️  Fuzzy matched: "${tagText}" -> Strapi tag (normalized: "${normalizedContentful}")`)
                    break
                  }
                }
              }
              
              return documentId
            })
            .filter(id => id !== null && id !== undefined)
          
          if (spaceTagsDocumentIds.length === 0) {
            spaceTagsDocumentIds = null
          } else {
            console.log(`     ✅ Mapped ${spaceTagsDocumentIds.length} of ${fields.spaceTags.length} spaceTags`)
          }
        }

        // First, create or find the entry (without media and relations)
        // Relations need to be set separately using connect syntax
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          description: mapText(fields.description),
          optixResourceId: mapText(fields.optixResourceId),
          // Note: spaceTags will be set via separate update with connect syntax
        }

        // Create entry in Strapi (will fail gracefully if duplicate slug exists)
        let strapiEntry
        try {
          strapiEntry = await createStrapiEntry('spaces', strapiData)
        } catch (createError) {
          // If duplicate slug error, the entry already exists - find it
          if (createError.message.includes('must be unique') && createError.message.includes('slug')) {
            console.log(`  ⚠️  Entry with slug "${mapText(fields.slug)}" already exists. Finding entry...`)
            const existing = await getStrapiEntries('spaces', { 
              filters: { slug: { $eq: mapText(fields.slug) } }
            })
            if (existing && existing.length > 0) {
              strapiEntry = existing[0]
              console.log(`  ℹ️  Found existing entry (ID: ${strapiEntry.id}, documentId: ${strapiEntry.documentId})`)
            } else {
              throw createError // Re-throw if we can't find it
            }
          } else {
            throw createError // Re-throw if it's a different error
          }
        }

        // Upload media files first, then attach them
        console.log('  📤 Uploading media files...')
        let featuredImageId = null

        // Handle featuredImage
        if (fields.featuredImage) {
          let featuredImageAsset = fields.featuredImage
          // If it's a link, resolve from includes
          if (featuredImageAsset.sys && featuredImageAsset.sys.type === 'Link') {
            featuredImageAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === featuredImageAsset.sys.id
            )
          }
          // Only upload if we have a resolved asset with fields
          if (featuredImageAsset && featuredImageAsset.fields) {
            featuredImageId = await uploadMediaToStrapi(featuredImageAsset, 'featuredImage')
            if (featuredImageId) {
              console.log(`  ✅ Uploaded featuredImage (ID: ${featuredImageId})`)
            }
          }
        }

        // Attach media and relations using REST API
        const { strapiRequest } = require('./utils')
        const entryId = strapiEntry.documentId || strapiEntry.id
        const updates = []

        // Prepare update data
        const updateData = {}
        
        if (featuredImageId !== null) {
          updateData.featuredImage = featuredImageId
          updates.push('featuredImage')
        }

        // Set spaceTags relations using connect syntax (Strapi v5 requires documentIds)
        if (spaceTagsDocumentIds !== null && spaceTagsDocumentIds.length > 0) {
          // Use shorthand syntax: connect: ['documentId1', 'documentId2']
          updateData.spaceTags = {
            connect: spaceTagsDocumentIds
          }
          updates.push(`${spaceTagsDocumentIds.length} spaceTags`)
        }

        // Update entry with media and relations
        if (Object.keys(updateData).length > 0) {
          console.log(`  🔄 Attaching ${updates.join(', ')} to entry...`)
          try {
            const updateResponse = await strapiRequest(
              `/api/spaces/${entryId}`,
              {
                method: 'PUT',
                body: JSON.stringify({ data: updateData }),
              }
            )
            console.log(`  ✅ Successfully attached: ${updates.join(', ')}`)
          } catch (error) {
            console.error(`  ⚠️  Failed to attach ${updates.join(', ')}: ${error.message.substring(0, 100)}`)
          }
        }

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

