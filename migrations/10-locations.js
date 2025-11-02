/**
 * Migration 4.10: Locations
 * 
 * Migrates Locations from Contentful to Strapi
 * 
 * Fields:
 * - title, subtitle, about, slug
 * - locationTags (Reference -> Relation, many-to-many)
 * - featuredImage (Media -> Media field, single) - with compression
 * - locationGallery (Media -> Media field, multiple) - with compression
 * - locationVideo (Media -> Media field, single) - with compression
 * - meetingSpacesDescriptionText, meetingSpacesHeaderText
 * - spaces (Reference -> Relation, many-to-many)
 * - locationOptions (Reference -> Relation, many-to-many)
 * - optionsDescriptionText, bookMeetingSpaceUrl
 * 
 * Execution sequence: 4.10
 * Dependencies:
 *   - LocationTags (4.2)
 *   - Spaces (4.5)
 *   - LocationOptions (4.9)
 * Media: featuredImage, locationGallery (multiple), locationVideo (uploaded with compression)
 */

const {
  contentfulClient,
  getStrapiEntries,
  strapiRequest,
  uploadMediaToStrapi,
  mapText,
  sleep,
} = require('./utils')

// Load ID mappings from Strapi for relations
let locationTagsMapping = new Map()
let spacesMapping = new Map()
let locationOptionsMapping = new Map()

async function loadLocationTagsMapping() {
  console.log('📋 Loading LocationTags ID mapping from Strapi...')
  try {
    const tags = await getStrapiEntries('locationtags')
    locationTagsMapping = new Map()
    
    for (const tag of tags) {
      // Store by both title and slug for matching
      if (tag.title) {
        locationTagsMapping.set(tag.title.toLowerCase().trim(), tag.documentId || tag.id)
      }
      if (tag.slug) {
        locationTagsMapping.set(tag.slug.toLowerCase().trim(), tag.documentId || tag.id)
      }
    }
    
    console.log(`   Loaded ${tags.length} LocationTags for mapping`)
    console.log(`   Sample tags: ${Array.from(locationTagsMapping.keys()).slice(0, 3).join(', ')}\n`)
  } catch (error) {
    console.log(`   ⚠️  Could not load LocationTags: ${error.message.substring(0, 100)}\n`)
  }
}

async function loadSpacesMapping() {
  console.log('📋 Loading Spaces ID mapping from Strapi...')
  try {
    const spaces = await getStrapiEntries('spaces')
    spacesMapping = new Map()
    
    for (const space of spaces) {
      // Store by slug for matching
      if (space.slug) {
        spacesMapping.set(space.slug.toLowerCase().trim(), space.documentId || space.id)
      }
      // Also by title as fallback
      if (space.title) {
        spacesMapping.set(space.title.toLowerCase().trim(), space.documentId || space.id)
      }
    }
    
    console.log(`   Loaded ${spaces.length} Spaces for mapping\n`)
  } catch (error) {
    console.log(`   ⚠️  Could not load Spaces: ${error.message.substring(0, 100)}\n`)
  }
}

async function loadLocationOptionsMapping() {
  console.log('📋 Loading LocationOptions ID mapping from Strapi...')
  try {
    const options = await getStrapiEntries('locationoptions')
    locationOptionsMapping = new Map()
    
    for (const option of options) {
      // Store by title for matching (trim to handle trailing spaces)
      if (option.title) {
        const titleKey = option.title.toLowerCase().trim()
        locationOptionsMapping.set(titleKey, option.documentId || option.id)
      }
    }
    
    console.log(`   Loaded ${options.length} LocationOptions for mapping`)
    console.log(`   Sample options: ${Array.from(locationOptionsMapping.keys()).slice(0, 5).join(', ')}\n`)
  } catch (error) {
    console.log(`   ⚠️  Could not load LocationOptions: ${error.message.substring(0, 100)}\n`)
  }
}

async function migrateLocations() {
  console.log('\n🚀 Starting Locations migration (4.10)...\n')

  // Load all required ID mappings
  await loadLocationTagsMapping()
  await loadSpacesMapping()
  await loadLocationOptionsMapping()

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
        console.log('─'.repeat(60))
        
        const locationSlug = (fields.slug || `location-${contentfulLocation.sys.id}`).trim()

        // Check if entry already exists
        try {
          const existing = await getStrapiEntries('locations', { filters: { slug: { $eq: locationSlug } } })
          if (existing && existing.length > 0) {
            console.log(`   ⚠️  Entry with slug "${locationSlug}" already exists (ID: ${existing[0].id})`)
            console.log('   ℹ️  Skipping migration - entry already exists')
            idMapping.set(contentfulLocation.sys.id, existing[0].id)
            successCount++
            continue
          }
        } catch (e) {
          // Ignore errors, proceed with creation
        }

        // Step 1: Map locationTags relations
        console.log('   📋 Step 1: Mapping locationTags relations...')
        let locationTagsDocumentIds = []
        if (fields.locationTags && Array.isArray(fields.locationTags)) {
          const expectedCount = fields.locationTags.length
          console.log(`     Found ${expectedCount} locationTags in Contentful`)
          
          for (const tag of fields.locationTags) {
            // Resolve Link references from includes
            let tagEntry = tag
            if (tag.sys && tag.sys.type === 'Link') {
              tagEntry = response.includes?.Entry?.find(
                entry => entry.sys.id === tag.sys.id && entry.sys.contentType.sys.id === 'locationTag'
              )
            }
            
            // Get title from resolved entry
            const tagTitle = tagEntry?.fields?.title || (typeof tag === 'string' ? tag : tag.toString())
            const tagKey = tagTitle.toLowerCase().trim()
            
            // Match to Strapi documentId
            const documentId = locationTagsMapping.get(tagKey)
            if (documentId) {
              locationTagsDocumentIds.push(documentId)
              console.log(`       ✅ Mapped: "${tagTitle}" -> ${documentId}`)
            } else {
              console.log(`       ⚠️  Could not map: "${tagTitle}" (key: "${tagKey}")`)
              console.log(`       Available keys: ${Array.from(locationTagsMapping.keys()).slice(0, 5).join(', ')}`)
            }
          }
          
          console.log(`     ✅ Mapped ${locationTagsDocumentIds.length} of ${expectedCount} locationTags`)
          if (locationTagsDocumentIds.length !== expectedCount) {
            console.log(`     ⚠️  WARNING: Missing ${expectedCount - locationTagsDocumentIds.length} locationTags!`)
          }
        } else {
          console.log('     ℹ️  No locationTags found')
        }

        // Step 2: Map spaces relations
        console.log('   📋 Step 2: Mapping spaces relations...')
        let spacesDocumentIds = []
        if (fields.locationSpaces && Array.isArray(fields.locationSpaces)) {
          const expectedCount = fields.locationSpaces.length
          console.log(`     Found ${expectedCount} spaces in Contentful`)
          
          for (const space of fields.locationSpaces) {
            // Resolve Link references from includes
            let spaceEntry = space
            if (space.sys && space.sys.type === 'Link') {
              spaceEntry = response.includes?.Entry?.find(
                entry => entry.sys.id === space.sys.id && entry.sys.contentType.sys.id === 'locationSpace'
              )
            }
            
            // Get slug from resolved entry
            const spaceSlug = spaceEntry?.fields?.slug || ''
            const spaceKey = spaceSlug.toLowerCase().trim()
            
            // Match to Strapi documentId
            const documentId = spacesMapping.get(spaceKey)
            if (documentId) {
              spacesDocumentIds.push(documentId)
              console.log(`       ✅ Mapped: "${spaceSlug}" -> ${documentId}`)
            } else {
              console.log(`       ⚠️  Could not map: "${spaceSlug}"`)
            }
          }
          
          console.log(`     ✅ Mapped ${spacesDocumentIds.length} of ${expectedCount} spaces`)
          if (spacesDocumentIds.length !== expectedCount) {
            console.log(`     ⚠️  WARNING: Missing ${expectedCount - spacesDocumentIds.length} spaces!`)
          }
        } else {
          console.log('     ℹ️  No spaces found')
        }

        // Step 3: Map locationOptions relations
        console.log('   📋 Step 3: Mapping locationOptions relations...')
        let locationOptionsDocumentIds = []
        if (fields.locationOptions && Array.isArray(fields.locationOptions)) {
          const expectedCount = fields.locationOptions.length
          console.log(`     Found ${expectedCount} locationOptions in Contentful`)
          
          for (const option of fields.locationOptions) {
            // Resolve Link references from includes
            let optionEntry = option
            if (option.sys && option.sys.type === 'Link') {
              optionEntry = response.includes?.Entry?.find(
                entry => entry.sys.id === option.sys.id && entry.sys.contentType.sys.id === 'locationOption'
              )
            }
            
            // Get title from resolved entry (trim to handle trailing spaces!)
            const optionTitle = optionEntry?.fields?.title || (typeof option === 'string' ? option : option.toString())
            const optionKey = optionTitle.toLowerCase().trim() // IMPORTANT: trim trailing spaces!
            
            // Match to Strapi documentId
            const documentId = locationOptionsMapping.get(optionKey)
            if (documentId) {
              locationOptionsDocumentIds.push(documentId)
              console.log(`       ✅ Mapped: "${optionTitle}" -> ${documentId}`)
            } else {
              console.log(`       ⚠️  Could not map: "${optionTitle}" (key: "${optionKey}")`)
              console.log(`       Available keys: ${Array.from(locationOptionsMapping.keys()).slice(0, 10).join(', ')}`)
            }
          }
          
          console.log(`     ✅ Mapped ${locationOptionsDocumentIds.length} of ${expectedCount} locationOptions`)
          if (locationOptionsDocumentIds.length !== expectedCount) {
            console.log(`     ⚠️  WARNING: Missing ${expectedCount - locationOptionsDocumentIds.length} locationOptions!`)
          }
        } else {
          console.log('     ℹ️  No locationOptions found')
        }

        // Step 4: Create entry first (without media and relations)
        console.log('   📋 Step 4: Creating location entry...')
        const strapiData = {
          title: mapText(fields.title),
          subtitle: mapText(fields.subtitle),
          about: mapText(fields.about),
          slug: locationSlug,
          meetingSpacesDescriptionText: mapText(fields.meetingSpacesDescriptionText),
          meetingSpacesHeaderText: mapText(fields.meetingSpacesHeaderText),
          optionsDescriptionText: mapText(fields.optionsDescriptionText),
          bookMeetingSpaceUrl: mapText(fields.bookMeetingSpaceUrl),
        }

        let strapiEntry = null
        try {
          const createResponse = await strapiRequest('/api/content-manager/collection-types/api::location.location', {
            method: 'POST',
            body: JSON.stringify(strapiData),
          })
          strapiEntry = createResponse
        } catch (cmError) {
          // Fall back to REST API
          try {
            const createResponse = await strapiRequest('/api/locations', {
              method: 'POST',
              body: JSON.stringify({ data: strapiData }),
            })
            strapiEntry = createResponse.data || createResponse
          } catch (restError) {
            throw new Error(`Failed to create entry: ${restError.message}`)
          }
        }

        // Use same pattern as spaces migration
        const entryId = strapiEntry.documentId || strapiEntry.id
        
        console.log(`     ✅ Created entry (documentId: ${entryId})`)

        // Step 5: Upload media files (with compression)
        console.log('   📋 Step 5: Uploading media files (with compression)...')
        
        let featuredImageId = null
        if (fields.featuredImage) {
          let featuredImageAsset = fields.featuredImage
          if (featuredImageAsset.sys && featuredImageAsset.sys.type === 'Link') {
            featuredImageAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === featuredImageAsset.sys.id
            )
          }
          if (featuredImageAsset && featuredImageAsset.fields) {
            console.log(`     📤 Uploading featuredImage...`)
            const uploadResult = await uploadMediaToStrapi(featuredImageAsset, 'featuredImage')
            if (uploadResult) {
              featuredImageId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
              console.log(`     ✅ Uploaded featuredImage (ID: ${featuredImageId})`)
              await sleep(2000) // Delay after upload
            } else {
              console.log(`     ❌ Failed to upload featuredImage`)
            }
          } else {
            console.log(`     ⚠️  featuredImage asset not found in includes`)
          }
        } else {
          console.log(`     ℹ️  No featuredImage to upload`)
        }

        // Upload gallery images (multiple) - with delays between uploads
        const galleryImageIds = []
        if (fields.gallery && Array.isArray(fields.gallery) && fields.gallery.length > 0) {
          console.log(`     📤 Uploading ${fields.gallery.length} gallery images...`)
          for (let j = 0; j < fields.gallery.length; j++) {
            let galleryAsset = fields.gallery[j]
            if (galleryAsset.sys && galleryAsset.sys.type === 'Link') {
              galleryAsset = response.includes?.Asset?.find(
                asset => asset.sys.id === galleryAsset.sys.id
              )
            }
            if (galleryAsset && galleryAsset.fields) {
              const fileName = galleryAsset.fields.file?.fileName || `gallery-${j}`
              console.log(`       📤 [${j + 1}/${fields.gallery.length}] Uploading: ${fileName}...`)
              const uploadResult = await uploadMediaToStrapi(galleryAsset, 'locationGallery')
              if (uploadResult) {
                const mediaId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
                galleryImageIds.push(mediaId)
                console.log(`       ✅ Uploaded (ID: ${mediaId})`)
              } else {
                console.log(`       ❌ Failed to upload ${fileName}`)
              }
              
              // Add delay between gallery uploads (important for many images)
              if (j < fields.gallery.length - 1) {
                await sleep(2000) // 2 second delay between gallery uploads
              }
            } else {
              console.log(`       ⚠️  Gallery asset ${j} not found in includes`)
            }
          }
          console.log(`     ✅ Uploaded ${galleryImageIds.length} of ${fields.gallery.length} gallery images`)
        } else {
          console.log(`     ℹ️  No gallery images to upload`)
        }

        let locationVideoId = null
        if (fields.locationVideo) {
          let locationVideoAsset = fields.locationVideo
          if (locationVideoAsset.sys && locationVideoAsset.sys.type === 'Link') {
            locationVideoAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === locationVideoAsset.sys.id
            )
          }
          if (locationVideoAsset && locationVideoAsset.fields) {
            console.log(`     📤 Uploading locationVideo...`)
            const uploadResult = await uploadMediaToStrapi(locationVideoAsset, 'locationVideo')
            if (uploadResult) {
              locationVideoId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
              console.log(`     ✅ Uploaded locationVideo (ID: ${locationVideoId})`)
              await sleep(2000) // Delay after upload
            } else {
              console.log(`     ❌ Failed to upload locationVideo`)
            }
          } else {
            console.log(`     ⚠️  locationVideo asset not found in includes`)
          }
        } else {
          console.log(`     ℹ️  No locationVideo to upload`)
        }

        // Step 6: Attach media and relations (using REST API like spaces migration)
        console.log('   📋 Step 6: Attaching media and relations...')
        const updateData = {}
        const updates = []
        
        if (featuredImageId !== null) {
          updateData.featuredImage = featuredImageId
          updates.push('featuredImage')
        }
        
        if (galleryImageIds.length > 0) {
          updateData.locationGallery = galleryImageIds
          updates.push(`${galleryImageIds.length} gallery images`)
        }
        
        if (locationVideoId !== null) {
          updateData.locationVideo = locationVideoId
          updates.push('locationVideo')
        }

        // Attach relations using connect syntax (Strapi v5) - same pattern as spaces
        if (locationTagsDocumentIds.length > 0) {
          updateData.locationTags = {
            connect: locationTagsDocumentIds
          }
          updates.push(`${locationTagsDocumentIds.length} locationTags`)
        }
        
        if (spacesDocumentIds.length > 0) {
          updateData.spaces = {
            connect: spacesDocumentIds
          }
          updates.push(`${spacesDocumentIds.length} spaces`)
        }
        
        if (locationOptionsDocumentIds.length > 0) {
          updateData.locationOptions = {
            connect: locationOptionsDocumentIds
          }
          updates.push(`${locationOptionsDocumentIds.length} locationOptions`)
        }

        // Update entry with media and relations using REST API (same pattern as spaces)
        if (Object.keys(updateData).length > 0) {
          console.log(`     🔄 Attaching: ${updates.join(', ')}...`)
          try {
            const updateResponse = await strapiRequest(
              `/api/locations/${entryId}`,
              {
                method: 'PUT',
                body: JSON.stringify({ data: updateData }),
              }
            )
            console.log(`     ✅ Update request successful`)
            
            // Wait a moment for Strapi to process the update
            await sleep(1000)
            
            // Verify the update worked - use simple populate to avoid errors
            let verified = null
            try {
              const verifyResponse = await strapiRequest(
                `/api/locations/${entryId}?populate=*`
              )
              verified = verifyResponse.data || verifyResponse
            } catch (verifyError) {
              // If populate fails, the attachments might still be correct
              // Log warning but don't fail the migration
              console.log(`     ⚠️  Could not verify attachments (but they may still be attached): ${verifyError.message.substring(0, 100)}`)
              verified = null // Will skip verification checks
            }
            
            // Only verify if we successfully fetched the entry
            if (verified) {
              console.log(`     🔍 Verification:`)
              
              // Check featuredImage
              if (featuredImageId) {
                if (verified.featuredImage && verified.featuredImage.id) {
                  console.log(`       ✅ featuredImage: ID ${verified.featuredImage.id}`)
                } else {
                  console.log(`       ⚠️  featuredImage: Could not verify (but may be attached)`)
                }
              }
              
              // Check locationGallery
              if (galleryImageIds.length > 0) {
                if (verified.locationGallery && Array.isArray(verified.locationGallery)) {
                  if (verified.locationGallery.length === galleryImageIds.length) {
                    console.log(`       ✅ locationGallery: ${verified.locationGallery.length} images`)
                  } else {
                    console.log(`       ⚠️  locationGallery: Expected ${galleryImageIds.length}, got ${verified.locationGallery.length}`)
                  }
                } else {
                  console.log(`       ⚠️  locationGallery: Could not verify (but may be attached)`)
                }
              }
              
              // Check locationVideo
              if (locationVideoId) {
                if (verified.locationVideo && verified.locationVideo.id) {
                  console.log(`       ✅ locationVideo: ID ${verified.locationVideo.id}`)
                } else {
                  console.log(`       ⚠️  locationVideo: Could not verify (but may be attached)`)
                }
              }
              
              // Check locationTags
              if (locationTagsDocumentIds.length > 0) {
                if (verified.locationTags && Array.isArray(verified.locationTags)) {
                  if (verified.locationTags.length === locationTagsDocumentIds.length) {
                    console.log(`       ✅ locationTags: ${verified.locationTags.length} tags`)
                  } else {
                    console.log(`       ⚠️  locationTags: Expected ${locationTagsDocumentIds.length}, got ${verified.locationTags.length}`)
                  }
                } else {
                  console.log(`       ⚠️  locationTags: Could not verify (but may be attached)`)
                }
              }
              
              // Check spaces
              if (spacesDocumentIds.length > 0) {
                if (verified.spaces && Array.isArray(verified.spaces)) {
                  if (verified.spaces.length === spacesDocumentIds.length) {
                    console.log(`       ✅ spaces: ${verified.spaces.length} spaces`)
                  } else {
                    console.log(`       ⚠️  spaces: Expected ${spacesDocumentIds.length}, got ${verified.spaces.length}`)
                  }
                } else {
                  console.log(`       ⚠️  spaces: Could not verify (but may be attached)`)
                }
              }
              
              // Check locationOptions
              if (locationOptionsDocumentIds.length > 0) {
                if (verified.locationOptions && Array.isArray(verified.locationOptions)) {
                  if (verified.locationOptions.length === locationOptionsDocumentIds.length) {
                    console.log(`       ✅ locationOptions: ${verified.locationOptions.length} options`)
                  } else {
                    console.log(`       ⚠️  locationOptions: Expected ${locationOptionsDocumentIds.length}, got ${verified.locationOptions.length}`)
                  }
                } else {
                  console.log(`       ⚠️  locationOptions: Could not verify (but may be attached)`)
                }
              }
            }
          } catch (error) {
            console.error(`     ❌ Failed to attach/verify media/relations: ${error.message}`)
            throw error // Don't continue if attachment fails
          }
        } else {
          console.log(`     ℹ️  No media or relations to attach`)
        }

        // Store ID mapping
        idMapping.set(contentfulLocation.sys.id, strapiEntry.id || entryId)
        successCount++
        console.log(`   ✅ Successfully migrated location: ${fields.title}`)

        // Rate limiting - wait between entries
        if (i < locations.length - 1) {
          await sleep(2000) // 2 second delay between entries
        }
      } catch (error) {
        console.error(`❌ Error migrating Location "${fields.title || contentfulLocation.sys.id}":`, error.message)
        console.error(`   Stack: ${error.stack}`)
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
