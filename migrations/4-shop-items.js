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
  uploadMediaToStrapi,
  mapText,
  mapNumber,
  mapBoolean,
  sleep,
} = require('./utils')

async function migrateShopItems() {
  console.log('\n🚀 Starting ShopItems migration (4.4)...\n')

  try {
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
        console.log(`\n[${i + 1}/${shopItems.length}] Processing: ${fields.title || 'Untitled'}`)

        // Upload media files first
        console.log('  📤 Uploading media files...')
        const mainImageId = await uploadMediaToStrapi(fields.mainImage, 'mainImage')
        const hoverImageId = await uploadMediaToStrapi(fields.hoverImage, 'hoverImage')

        // Map fields according to field mapping rules
        const strapiData = {
          title: mapText(fields.title),
          slug: mapText(fields.slug),
          subtitle: mapText(fields.subtitle),
          price: mapNumber(fields.price),
          mainImage: mainImageId, // Single media relation ID
          hoverImage: hoverImageId, // Single media relation ID
          oneSize: mapBoolean(fields.oneSize),
          sizes: fields.sizes && Array.isArray(fields.sizes)
            ? fields.sizes.map(size => typeof size === 'object' ? size.size : size)
            : null,
        }

        // Create entry in Strapi
        const strapiEntry = await createStrapiEntry('shop-items', strapiData)

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

