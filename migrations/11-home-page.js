/**
 * Migration 4.11: HomePage (Singleton)
 * 
 * Migrates HomePage from Contentful to Strapi as a singleton
 * 
 * Fields (grouped):
 * Hero Section:
 * - hero.titleFirstSentence (Text -> Short text)
 * - hero.titleSecondSentence (Text -> Short text)
 * - hero.image (Media -> Media field, single)
 * 
 * Locations Section:
 * - locations.title (Text -> Short text)
 * - locations.description (Text -> Long text)
 * - locations.videoFile (Media -> Media field, single)
 * - locations.videoImagePlaceholder (Media -> Media field, single)
 * 
 * Events Section:
 * - events.title (Text -> Short text)
 * - events.description (Text -> Long text)
 * - events.heroImage (Media -> Media field, single)
 * 
 * Journal Section:
 * - journal.title (Text -> Short text)
 * - journal.description (Text -> Long text)
 * 
 * Shop Section:
 * - shop.title (Text -> Short text)
 * - shop.description (Text -> Long text)
 * - shop.heroImage (Media -> Media field, single)
 * - shop.rectangularProductOne (Reference -> Relation, one-to-one)
 * - shop.rectangularProductTwo (Reference -> Relation, one-to-one)
 * - shop.squareProductOne (Reference -> Relation, one-to-one)
 * - shop.squareProductTwo (Reference -> Relation, one-to-one)
 * - shop.squareProductThree (Reference -> Relation, one-to-one)
 * 
 * Execution sequence: 4.11
 * Dependencies: ShopItems (4.4) - requires idMapping for shop product references
 * Media: hero.image, locations.videoFile, locations.videoImagePlaceholder, events.heroImage, shop.heroImage
 * 
 * Note: HomePage is a singleton - there should only be one entry
 */

const {
  contentfulClient,
  createStrapiEntry,
  updateStrapiEntry,
  getStrapiEntries,
  uploadMediaToStrapi,
  mapText,
  mapReference,
  sleep,
} = require('./utils')

async function migrateHomePage(shopItemsIdMapping = null) {
  console.log('\n🚀 Starting HomePage (Singleton) migration (4.11)...\n')

  // ID mapping for ShopItems (from ShopItems migration)
  let shopItemsMapping = shopItemsIdMapping || new Map()

  if (!shopItemsMapping || shopItemsMapping.size === 0) {
    console.log('⚠️  No ShopItems ID mapping provided. Shop product relations may fail.')
    console.log('    Ensure ShopItems migration (4.4) completed successfully.')
  }

  try {
    // Fetch HomePage from Contentful (should be only one)
    console.log('📥 Fetching HomePage from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'homePage',
      include: 10, // Include assets and linked entries
      limit: 1, // Only one singleton
    })

    if (!response.items || response.items.length === 0) {
      console.log('⚠️  No HomePage found in Contentful. Skipping migration.')
      return { success: true, count: 0 }
    }

    const contentfulHomePage = response.items[0]
    const fields = contentfulHomePage.fields

    console.log('Processing HomePage singleton...\n')

    // Upload all media files first
    console.log('📤 Uploading media files...')
    
    // Hero section media
    const heroImageId = await uploadMediaToStrapi(fields.hero?.image, 'hero.image')
    
    // Locations section media
    const locationsVideoFileId = await uploadMediaToStrapi(
      fields.locations?.videoFile,
      'locations.videoFile'
    )
    const locationsVideoImagePlaceholderId = await uploadMediaToStrapi(
      fields.locations?.videoImagePlaceholder,
      'locations.videoImagePlaceholder'
    )
    
    // Events section media
    const eventsHeroImageId = await uploadMediaToStrapi(
      fields.events?.heroImage,
      'events.heroImage'
    )
    
    // Shop section media
    const shopHeroImageId = await uploadMediaToStrapi(
      fields.shop?.heroImage,
      'shop.heroImage'
    )

    // Map shop product references
    const rectangularProductOneId = mapReference(
      fields.shop?.rectangularProductOne,
      shopItemsMapping
    )
    const rectangularProductTwoId = mapReference(
      fields.shop?.rectangularProductTwo,
      shopItemsMapping
    )
    const squareProductOneId = mapReference(
      fields.shop?.squareProductOne,
      shopItemsMapping
    )
    const squareProductTwoId = mapReference(
      fields.shop?.squareProductTwo,
      shopItemsMapping
    )
    const squareProductThreeId = mapReference(
      fields.shop?.squareProductThree,
      shopItemsMapping
    )

    // Map fields according to field mapping rules (grouped structure)
    const strapiData = {
      hero: {
        titleFirstSentence: mapText(fields.hero?.titleFirstSentence),
        titleSecondSentence: mapText(fields.hero?.titleSecondSentence),
        image: heroImageId,
      },
      locations: {
        title: mapText(fields.locations?.title),
        description: mapText(fields.locations?.description),
        videoFile: locationsVideoFileId,
        videoImagePlaceholder: locationsVideoImagePlaceholderId,
      },
      events: {
        title: mapText(fields.events?.title),
        description: mapText(fields.events?.description),
        heroImage: eventsHeroImageId,
      },
      journal: {
        title: mapText(fields.journal?.title),
        description: mapText(fields.journal?.description),
      },
      shop: {
        title: mapText(fields.shop?.title),
        description: mapText(fields.shop?.description),
        heroImage: shopHeroImageId,
        rectangularProductOne: rectangularProductOneId,
        rectangularProductTwo: rectangularProductTwoId,
        squareProductOne: squareProductOneId,
        squareProductTwo: squareProductTwoId,
        squareProductThree: squareProductThreeId,
      },
    }

    // Check if HomePage already exists (singleton)
    const existingHomePages = await getStrapiEntries('home-page')
    
    let strapiEntry
    if (existingHomePages && existingHomePages.length > 0) {
      // Update existing entry
      console.log('📝 Updating existing HomePage entry...')
      strapiEntry = await updateStrapiEntry('home-page', existingHomePages[0].id, strapiData)
      console.log('✅ HomePage updated successfully')
    } else {
      // Create new entry
      strapiEntry = await createStrapiEntry('home-page', strapiData)
      console.log('✅ HomePage created successfully')
    }

    console.log(`\n✅ HomePage (Singleton) migration completed!`)

    return {
      success: true,
      count: 1,
      idMapping: strapiEntry ? { [contentfulHomePage.sys.id]: strapiEntry.id } : null,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in HomePage migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateHomePage()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateHomePage

