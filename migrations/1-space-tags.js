/**
 * Migration 4.1: SpaceTags
 * 
 * Migrates SpaceTags from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * 
 * Execution sequence: 4.1
 */

const {
  contentfulClient,
  createStrapiEntry,
  createStrapiContentType,
  contentTypeExists,
  mapText,
  sleep,
} = require('./utils')

async function migrateSpaceTags() {
  console.log('\n🚀 Starting SpaceTags migration (4.1)...\n')

  try {
    // Step 1: Create content type via Admin API
    console.log('📋 Step 1: Creating content type via Admin API...')
    const contentTypeId = 'space-tag'
    const pluralName = 'space-tags'
    
    // First check if content type already exists in Strapi (via API)
    const apiExists = await contentTypeExists(pluralName)
    if (apiExists) {
      console.log(`✅ Content type "${pluralName}" already exists in Strapi API`)
      console.log('   Skipping content type creation, proceeding to entry migration...')
      console.log('')
    } else {
      // Try to create content type via Admin API
      const schema = {
        kind: 'collectionType',
        collectionName: pluralName,
        info: {
          singularName: contentTypeId,
          pluralName: pluralName,
          displayName: 'Space Tag',
          description: 'Tags for spaces',
        },
        options: {
          draftAndPublish: true,
        },
        pluginOptions: {},
        attributes: {
          title: {
            type: 'string',
            required: true,
          },
          slug: {
            type: 'string',
            required: true,
            unique: true,
          },
        },
      }
      
      try {
        await createStrapiContentType(contentTypeId, pluralName, { contentType: schema })
        console.log('')
      } catch (error) {
        console.error('⚠️  Failed to create content type via API:', error.message)
        console.log('')
        console.log('📋 IMPORTANT: Content Type Builder API is not available via REST in Strapi Cloud.')
        console.log('')
        console.log('   Please create the content type manually in Strapi Admin:')
        console.log(`   1. Go to Content-Type Builder in Strapi Admin`)
        console.log(`   2. Create Collection Type: "Space Tag"`)
        console.log(`   3. Add fields:`)
        console.log(`      - title (Text, Short text, Required)`)
        console.log(`      - slug (Text, Short text, Required, Unique)`)
        console.log(`   4. Save`)
        console.log(`   5. Then run this migration again`)
        console.log('')
        throw new Error('Content type must be created manually. See instructions above.')
      }
    }
    
    console.log('')
    
    // Step 2: Migrate entries
    console.log('📋 Step 2: Migrating entries from Contentful...')
    // Fetch all Location Spaces from Contentful to extract spaceTags
    console.log('📥 Fetching Location Spaces from Contentful to extract spaceTags...')
    const response = await contentfulClient.getEntries({
      content_type: 'locationSpace',
      include: 2,
    })

    const locationSpaces = response.items
    console.log(`Found ${locationSpaces.length} Location Spaces in Contentful\n`)

    // Extract all unique spaceTags from all locationSpaces
    const uniqueSpaceTags = new Set()
    const spaceTagToContentfulId = new Map() // Map tag text -> first Contentful space ID that had it

    locationSpaces.forEach((space) => {
      const spaceTags = space.fields.spaceTags || []
      spaceTags.forEach((tag) => {
        // Trim whitespace and normalize
        const normalizedTag = tag.trim()
        if (normalizedTag && !uniqueSpaceTags.has(normalizedTag)) {
          uniqueSpaceTags.add(normalizedTag)
          spaceTagToContentfulId.set(normalizedTag, space.sys.id)
        }
      })
    })

    const spaceTagsArray = Array.from(uniqueSpaceTags)
    console.log(`Found ${spaceTagsArray.length} unique spaceTags:\n`)
    spaceTagsArray.forEach((tag, idx) => {
      console.log(`  ${idx + 1}. ${tag}`)
    })
    console.log('')

    if (spaceTagsArray.length === 0) {
      console.log('⚠️  No SpaceTags found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: SpaceTag text -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each unique SpaceTag
    for (let i = 0; i < spaceTagsArray.length; i++) {
      const tagText = spaceTagsArray[i]

      try {
        console.log(`\n[${i + 1}/${spaceTagsArray.length}] Processing: ${tagText}`)

        // Generate slug from tag text (lowercase, replace spaces with hyphens)
        const slug = tagText.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

        // Map fields according to field mapping rules
        const strapiData = {
          title: tagText.trim(),
          slug: slug,
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('space-tags', strapiData)

        // Store ID mapping (using tag text as key since there's no Contentful ID for tags)
        idMapping.set(tagText.trim(), strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < spaceTagsArray.length - 1) {
          await sleep(500) // 500ms delay
        }
      } catch (error) {
        console.error(`❌ Error migrating SpaceTag "${tagText}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ SpaceTags migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${spaceTagsArray.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in SpaceTags migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateSpaceTags()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateSpaceTags

