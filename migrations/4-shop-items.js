/**
 * Migration 4.4: ShopItems
 * 
 * Migrates ShopItems from Contentful to Strapi
 * 
 * Fields:
 * - title (Text -> Short text)
 * - slug (Text -> Short text)
 * - subtitle (Text -> Short text)
 * - price (Number -> Number)
 * - mainImage (Media -> Media field, single)
 * - hoverImage (Media -> Media field, single)
 * - oneSize (Boolean -> Boolean)
 * - sizes (Array -> Array of text fields)
 * 
 * Execution sequence: 4.4
 * Media: mainImage, hoverImage (uploaded as part of entry creation)
 */

const {
  contentfulClient,
  createStrapiEntry,
  getStrapiEntries,
  uploadMediaToStrapi,
  mapText,
  mapNumber,
  mapBoolean,
  sleep,
} = require('./utils')

async function migrateShopItems() {
  console.log('\n🚀 Starting ShopItems migration (4.4)...\n')

  try {
    // Step 1: Check if content type exists
    console.log('📋 Step 1: Checking content type...')
    const pluralName = 'shopitems'
    
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
    // Fetch all ShopItems from Contentful
    console.log('📥 Fetching ShopItems from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'shopItem',
      include: 10, // Include assets and linked entries
    })

    const shopItems = response.items
    console.log(`Found ${shopItems.length} ShopItems in Contentful\n`)

    if (shopItems.length === 0) {
      console.log('⚠️  No ShopItems found in Contentful. Skipping migration.')
      return { success: true, count: 0, idMapping: new Map() }
    }

    // ID mapping: Contentful ID -> Strapi ID
    const idMapping = new Map()
    let successCount = 0
    let errorCount = 0

    // Migrate each ShopItem
    for (let i = 0; i < shopItems.length; i++) {
      const contentfulItem = shopItems[i]
      const fields = contentfulItem.fields

      try {
        const itemTitle = fields.title || 'Untitled'
        console.log(`\n[${i + 1}/${shopItems.length}] Processing: ${itemTitle}`)

        // First, create or find the entry (without media)
        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          subtitle: mapText(fields.subtitle),
          price: mapNumber(fields.price),
          oneSize: mapBoolean(fields.oneSize),
          sizes: fields.sizes && Array.isArray(fields.sizes)
            ? fields.sizes.map(size => typeof size === 'object' ? size.size || size : size)
            : null,
        }

        // Create entry in Strapi (will fail gracefully if duplicate slug exists)
        let strapiEntry
        try {
          strapiEntry = await createStrapiEntry('shopitems', strapiData)
        } catch (createError) {
          // If duplicate slug error, the entry already exists - find it
          if (createError.message.includes('must be unique') && createError.message.includes('slug')) {
            console.log(`  ⚠️  Entry with slug "${mapText(fields.slug)}" already exists. Finding entry...`)
            const existing = await getStrapiEntries('shopitems', { 
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

        // Upload media files first, then attach them via Content Manager API
        // Using Content Manager API as it seems more reliable for media attachments
        console.log('  📤 Uploading media files...')
        let mainImageId = null
        let hoverImageId = null

        // Handle mainImage
        if (fields.mainImage) {
          let mainImageAsset = fields.mainImage
          if (mainImageAsset.sys && mainImageAsset.sys.type === 'Link') {
            mainImageAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === mainImageAsset.sys.id
            )
          }
          if (mainImageAsset && mainImageAsset.fields) {
            mainImageId = await uploadMediaToStrapi(mainImageAsset, 'mainImage')
            if (mainImageId) console.log(`  ✅ Uploaded mainImage (ID: ${mainImageId})`)
          }
        }

        // Handle hoverImage
        if (fields.hoverImage) {
          let hoverImageAsset = fields.hoverImage
          if (hoverImageAsset.sys && hoverImageAsset.sys.type === 'Link') {
            hoverImageAsset = response.includes?.Asset?.find(
              asset => asset.sys.id === hoverImageAsset.sys.id
            )
          }
          if (hoverImageAsset && hoverImageAsset.fields) {
            hoverImageId = await uploadMediaToStrapi(hoverImageAsset, 'hoverImage')
            if (hoverImageId) console.log(`  ✅ Uploaded hoverImage (ID: ${hoverImageId})`)
          }
        }

        // Attach media using REST API with numeric ID
        if (mainImageId !== null || hoverImageId !== null) {
          console.log('  🔄 Attaching media to entry...')
          const { strapiRequest } = require('./utils')
          const updateData = {}
          if (mainImageId !== null) updateData.mainImage = mainImageId
          if (hoverImageId !== null) updateData.hoverImage = hoverImageId

          try {
            // Use numeric ID for REST API
            const updateResponse = await strapiRequest(
              `/api/shopitems/${strapiEntry.id}`,
              {
                method: 'PUT',
                body: JSON.stringify({ data: updateData }),
              }
            )
            console.log(`  ✅ Media attached successfully`)
          } catch (error) {
            console.error(`  ⚠️  Failed to attach media (will check admin panel): ${error.message.substring(0, 100)}`)
          }
        }

        // Store ID mapping
        idMapping.set(contentfulItem.sys.id, strapiEntry.id)
        successCount++

        // Rate limiting - wait a bit between requests
        if (i < shopItems.length - 1) {
          await sleep(1000) // 1 second delay for media uploads
        }
      } catch (error) {
        console.error(`❌ Error migrating ShopItem "${fields.title || contentfulItem.sys.id}":`, error.message)
        errorCount++
      }
    }

    console.log(`\n✅ ShopItems migration completed!`)
    console.log(`   Success: ${successCount}`)
    console.log(`   Errors: ${errorCount}`)
    console.log(`   Total: ${shopItems.length}`)

    return {
      success: errorCount === 0,
      count: successCount,
      errors: errorCount,
      idMapping,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in ShopItems migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateShopItems()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateShopItems

