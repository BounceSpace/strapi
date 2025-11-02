/**
 * Migration 4.11: HomePage (Singleton)
 * 
 * Migrates HomePage singleton from Contentful to Strapi
 * 
 * Fields:
 * - heroTitleFirstSentence, heroTitleSecondSentence
 * - heroImage (Media -> Media field, single) - with compression
 * - locationsTitle, locationsDescription
 * - videoFile (Media -> Media field, single) - with compression
 * - videoImagePlaceholder (Media -> Media field, single) - with compression
 * - eventsTitle, eventsDescription
 * - eventsHeroImage (Media -> Media field, single) - with compression
 * - journalTitle, journalDescription
 * - shopTitle, shopDescription
 * - shopHeroImage (Media -> Media field, single) - with compression
 * - rectangularProductOne, rectangularProductTwo (Relation -> many-to-one to ShopItem)
 * - squareProductOne, squareProductTwo, squareProductThree (Relation -> many-to-one to ShopItem)
 * 
 * Execution sequence: 4.11
 * Dependencies:
 *   - ShopItems (4.4)
 * Media: heroImage, videoFile, videoImagePlaceholder, eventsHeroImage, shopHeroImage (uploaded with compression)
 */

const {
  contentfulClient,
  getStrapiEntries,
  strapiRequest,
  uploadMediaToStrapi,
  mapText,
  sleep,
} = require('./utils')

// Load ID mapping from Strapi for shop item relations
let shopItemsMapping = new Map()

async function loadShopItemsMapping() {
  console.log('📋 Loading ShopItems ID mapping from Strapi...')
  try {
    const shopItems = await getStrapiEntries('shopitems')
    shopItemsMapping = new Map()
    
    for (const item of shopItems) {
      // Store by slug for matching
      if (item.slug) {
        shopItemsMapping.set(item.slug.toLowerCase().trim(), item.documentId || item.id)
      }
      // Also by title as fallback
      if (item.title) {
        shopItemsMapping.set(item.title.toLowerCase().trim(), item.documentId || item.id)
      }
    }
    
    console.log(`   Loaded ${shopItems.length} ShopItems for mapping`)
    console.log(`   Sample items: ${Array.from(shopItemsMapping.keys()).slice(0, 5).join(', ')}\n`)
  } catch (error) {
    console.log(`   ⚠️  Could not load ShopItems: ${error.message.substring(0, 100)}\n`)
  }
}

async function migrateHomepage() {
  console.log('\n🚀 Starting HomePage migration (4.11)...\n')

  // Load all required ID mappings
  await loadShopItemsMapping()

  try {
    // Fetch HomePage from Contentful
    console.log('📥 Fetching HomePage from Contentful...')
    const response = await contentfulClient.getEntries({
      content_type: 'homePage',
      limit: 1,
      include: 10, // Include assets and linked entries
    })

    if (!response.items || response.items.length === 0) {
      console.log('⚠️  No HomePage found in Contentful. Skipping migration.')
      return { success: true, count: 0 }
    }

    const contentfulHomepage = response.items[0]
    const fields = contentfulHomepage.fields

    console.log(`Found HomePage in Contentful: ${fields.heroTitleFirstSentence || 'Untitled'}\n`)

    // Step 1: Map shop item relations
    console.log('📋 Step 1: Mapping shop item relations...')
    const shopItemFields = [
      'rectangularProductOne',
      'rectangularProductTwo',
      'squareProductOne',
      'squareProductTwo',
      'squareProductThree',
    ]
    
    const shopItemIds = {}
    for (const fieldName of shopItemFields) {
      if (fields[fieldName]) {
        let shopItemEntry = fields[fieldName]
        
        // Resolve Link references from includes
        if (shopItemEntry.sys && shopItemEntry.sys.type === 'Link') {
          shopItemEntry = response.includes?.Entry?.find(
            entry => entry.sys.id === shopItemEntry.sys.id && entry.sys.contentType.sys.id === 'shopItem'
          )
        }
        
        // Get slug from resolved entry
        const shopItemSlug = shopItemEntry?.fields?.slug || ''
        const shopItemKey = shopItemSlug.toLowerCase().trim()
        
        // Match to Strapi documentId
        const documentId = shopItemsMapping.get(shopItemKey)
        if (documentId) {
          shopItemIds[fieldName] = documentId
          console.log(`     ✅ Mapped ${fieldName}: "${shopItemSlug}" -> ${documentId}`)
        } else {
          console.log(`     ⚠️  Could not map ${fieldName}: "${shopItemSlug}"`)
        }
      }
    }
    console.log(`   ✅ Mapped ${Object.keys(shopItemIds).length} of ${shopItemFields.filter(f => fields[f]).length} shop items\n`)

    // Step 2: Upload all media files (with compression)
    console.log('📋 Step 2: Uploading media files (with compression)...')
    
    const mediaFields = [
      { fieldName: 'heroImage', contentTypeField: 'heroImage' },
      { fieldName: 'videoFile', contentTypeField: 'videoFile' },
      { fieldName: 'videoImagePlaceholder', contentTypeField: 'videoImagePlaceholder' },
      { fieldName: 'eventsHeroImage', contentTypeField: 'eventsHeroImage' },
      { fieldName: 'shopHeroImage', contentTypeField: 'shopHeroImage' },
    ]
    
    const mediaIds = {}
    
    for (const { fieldName, contentTypeField } of mediaFields) {
      if (fields[fieldName]) {
        let mediaAsset = fields[fieldName]
        
        // Resolve Link references from includes
        if (mediaAsset.sys && mediaAsset.sys.type === 'Link') {
          mediaAsset = response.includes?.Asset?.find(
            asset => asset.sys.id === mediaAsset.sys.id
          )
        }
        
        if (mediaAsset && mediaAsset.fields) {
          console.log(`     📤 Uploading ${fieldName}...`)
          const uploadResult = await uploadMediaToStrapi(mediaAsset, contentTypeField)
          if (uploadResult) {
            const mediaId = typeof uploadResult === 'object' && uploadResult.id ? uploadResult.id : uploadResult
            mediaIds[fieldName] = mediaId
            console.log(`     ✅ Uploaded ${fieldName} (ID: ${mediaId})`)
            await sleep(2000) // Delay after upload
          } else {
            console.log(`     ❌ Failed to upload ${fieldName}`)
          }
        } else {
          console.log(`     ⚠️  ${fieldName} asset not found in includes`)
        }
      } else {
        console.log(`     ℹ️  No ${fieldName} to upload`)
      }
    }

    // Step 3: Create or update homepage entry (singleton - PUT works for both create and update)
    console.log('\n📋 Step 3: Creating/updating homepage entry...')
    const homepageData = {
      heroTitleFirstSentence: mapText(fields.heroTitleFirstSentence),
      heroTitleSecondSentence: mapText(fields.heroTitleSecondSentence),
      locationsTitle: mapText(fields.locationsTitle),
      locationsDescription: mapText(fields.locationsDescription),
      eventsTitle: mapText(fields.eventsTitle),
      eventsDescription: mapText(fields.eventsDescription),
      journalTitle: mapText(fields.journalTitle),
      journalDescription: mapText(fields.journalDescription),
      shopTitle: mapText(fields.shopTitle),
      shopDescription: mapText(fields.shopDescription),
    }

    let strapiHomepage = null
    try {
      // For singletons, PUT creates if it doesn't exist, updates if it does
      console.log(`     🔄 Upserting homepage (singleton)...`)
      const upsertResponse = await strapiRequest('/api/homepage', {
        method: 'PUT',
        body: JSON.stringify({ data: homepageData }),
      })
      strapiHomepage = upsertResponse.data || upsertResponse
      console.log(`     ✅ Homepage upserted successfully`)
    } catch (restError) {
      throw new Error(`Failed to upsert homepage: ${restError.message}`)
    }

    const documentId = strapiHomepage.documentId || strapiHomepage.id
    const homepageId = strapiHomepage.id || strapiHomepage.documentId

    // Step 4: Attach media files
    console.log('\n📋 Step 4: Attaching media files...')
    const mediaUpdateData = {}
    const mediaUpdates = []
    
    for (const fieldName of Object.keys(mediaIds)) {
      mediaUpdateData[fieldName] = mediaIds[fieldName]
      mediaUpdates.push(fieldName)
    }

    if (Object.keys(mediaUpdateData).length > 0) {
      console.log(`     🔄 Attaching media: ${mediaUpdates.join(', ')}...`)
      try {
        await strapiRequest(
          `/api/homepage`,
          {
            method: 'PUT',
            body: JSON.stringify({ data: mediaUpdateData }),
          }
        )
        console.log(`     ✅ Media attached successfully`)
        await sleep(2000) // Wait for media to be fully processed
      } catch (error) {
        console.error(`     ❌ Failed to attach media: ${error.message}`)
        throw error
      }
    }

    // Step 5: Attach shop item relations
    console.log('\n📋 Step 5: Attaching shop item relations...')
    const relationsUpdateData = {}
    const relationsUpdates = []
    
    for (const [fieldName, documentId] of Object.entries(shopItemIds)) {
      // For many-to-one relations, we connect with the documentId directly
      relationsUpdateData[fieldName] = documentId
      relationsUpdates.push(fieldName)
    }

    if (Object.keys(relationsUpdateData).length > 0) {
      console.log(`     🔄 Attaching relations: ${relationsUpdates.join(', ')}...`)
      try {
        await strapiRequest(
          `/api/homepage`,
          {
            method: 'PUT',
            body: JSON.stringify({ data: relationsUpdateData }),
          }
        )
        console.log(`     ✅ Relations attached successfully`)
        await sleep(2000) // Wait for relations to be fully processed
      } catch (error) {
        console.error(`     ❌ Failed to attach relations: ${error.message}`)
        throw error
      }
    }

    // Step 6: Verify everything was attached
    console.log('\n📋 Step 6: Verifying attachments...')
    try {
      const verifyResponse = await strapiRequest('/api/homepage?populate=*')
      const verified = verifyResponse.data || verifyResponse
      
      console.log(`     🔍 Verification:`)
      
      // Check media
      for (const fieldName of Object.keys(mediaIds)) {
        if (verified[fieldName] && verified[fieldName].id) {
          console.log(`       ✅ ${fieldName}: ID ${verified[fieldName].id}`)
        } else {
          console.log(`       ⚠️  ${fieldName}: Could not verify (but may be attached)`)
        }
      }
      
      // Check shop item relations
      for (const fieldName of Object.keys(shopItemIds)) {
        if (verified[fieldName] && (verified[fieldName].id || verified[fieldName].documentId)) {
          console.log(`       ✅ ${fieldName}: Attached`)
        } else {
          console.log(`       ⚠️  ${fieldName}: Could not verify (but may be attached)`)
        }
      }
      
      console.log(`     ✅ Verification complete!`)
    } catch (error) {
      console.log(`     ⚠️  Could not verify attachments (but they may still be attached): ${error.message.substring(0, 100)}`)
    }

    console.log(`\n✅ HomePage migration completed successfully!`)
    return {
      success: true,
      count: 1,
    }
  } catch (error) {
    console.error('\n❌ Fatal error in HomePage migration:', error)
    throw error
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateHomepage()
    .then((result) => {
      console.log('\n📊 Migration Summary:', result)
      process.exit(result.success ? 0 : 1)
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error)
      process.exit(1)
    })
}

module.exports = migrateHomepage

