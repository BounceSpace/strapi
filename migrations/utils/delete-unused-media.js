/**
 * Script to delete all unused media files from Strapi
 * 
 * This script:
 * 1. Fetches all media files from Strapi
 * 2. Checks all collection types that use media
 * 3. Collects all media IDs that are referenced
 * 4. Deletes media files that aren't referenced anywhere
 */

require('dotenv').config()
const { getStrapiEntries, strapiRequest, sleep } = require('./index')

const STRAPI_URL = process.env.STRAPI_URL

// Collection types that have media fields
const COLLECTIONS_WITH_MEDIA = {
  journals: ['featuredImage', 'thumbnailImage'],
  spaces: ['featuredImage'],
  shopitems: ['mainImage', 'hoverImage'],
  locations: ['heroImage', 'thumbnailImage', 'featuredImage'], // Need to verify
  pages: ['heroImage', 'featuredImage'], // Need to verify
  homepage: ['heroImage', 'featuredImage', 'section1Image', 'section2Image', 'section3Image'], // Need to verify
  events: [], // Need to check
}

// Also check richtext fields for embedded images
const COLLECTIONS_WITH_RICHTEXT = {
  journals: ['body'],
  pages: ['content'],
  homepage: [], // Need to check
}

/**
 * Extract media IDs from a richtext field
 * Richtext can be either:
 * 1. JSON string (Lexical format with blocks)
 * 2. Markdown string (with ![filename](url) syntax)
 */
function extractMediaIdsFromRichtext(richtextString) {
  if (!richtextString || typeof richtextString !== 'string') {
    return []
  }

  const mediaIds = []
  
  // Method 1: Check if it's Markdown format (contains ![filename](url))
  const markdownImageRegex = /!\[.*?\]\(([^)]+)\)/g
  const markdownMatches = richtextString.matchAll(markdownImageRegex)
  
  for (const match of markdownMatches) {
    const imageUrl = match[1]
    // Extract media ID from Strapi media URL
    // Strapi URLs look like: https://...media.strapiapp.com/filename_hash.ext
    // We can't directly extract ID from URL, but we can check if the URL matches uploaded files
    // For now, we'll need to fetch all media and match by URL
  }
  
  // Method 2: Check if it's JSON format (Lexical blocks)
  try {
    // Try parsing as JSON
    const richtext = JSON.parse(richtextString)
    const mediaIdsFromJson = []
    
    function traverse(node) {
      if (typeof node !== 'object' || node === null) return
      
      // Check for image blocks with media ID
      if (node.type === 'image' && node.image) {
        // Image ID might be a number or in an object
        const imageId = typeof node.image === 'number' ? node.image : node.image.id || node.image
        if (imageId) {
          mediaIdsFromJson.push(imageId)
        }
      }
      
      // Recursively check children
      if (Array.isArray(node.children)) {
        node.children.forEach(traverse)
      } else if (typeof node === 'object') {
        Object.values(node).forEach(traverse)
      }
    }
    
    traverse(richtext)
    mediaIds.push(...mediaIdsFromJson)
  } catch (e) {
    // Not JSON, assume it's Markdown (handled above)
  }
  
  return mediaIds
}

/**
 * Extract media IDs from Markdown richtext by matching URLs
 */
async function extractMediaIdsFromMarkdownRichtext(richtextString, allMediaFiles) {
  if (!richtextString || typeof richtextString !== 'string') {
    return []
  }

  const mediaIds = []
  
  // Find all markdown image syntax: ![alt](url)
  const markdownImageRegex = /!\[.*?\]\(([^)]+)\)/g
  const matches = [...richtextString.matchAll(markdownImageRegex)]
  
  for (const match of matches) {
    const imageUrl = match[1].trim()
    if (!imageUrl) continue
    
    // Extract filename from URL (e.g., "filename_hash.jpg" from full URL)
    const urlFilename = imageUrl.split('/').pop().split('?')[0] // Get filename, remove query params
    
    // Match media files by URL - try multiple matching strategies
    // Primary strategy: Match by filename extracted from URL (most reliable)
    const matchingFile = allMediaFiles.find(file => {
      if (!file.url) return false
      
      // Strategy 1: Exact URL match (most reliable)
      if (file.url === imageUrl) return true
      
      // Strategy 2: Match by filename from URL path (handles hash suffixes correctly)
      const fileUrlFilename = file.url.split('/').pop().split('?')[0]
      if (fileUrlFilename === urlFilename) return true
      
      // Strategy 3: Match by filename from name field vs URL filename (in case name doesn't match URL)
      const fileNameFromName = (file.name || '').split('/').pop().split('?')[0]
      // Normalize both filenames (handle underscores vs dashes, case differences)
      const normalize = (s) => s.toLowerCase().replace(/[_-]/g, '')
      if (normalize(fileUrlFilename) === normalize(urlFilename)) return true
      if (normalize(fileNameFromName) === normalize(urlFilename)) return true
      
      return false
    })
    
    if (matchingFile && matchingFile.id) {
      mediaIds.push(matchingFile.id)
    } else {
      // Log if we couldn't match (for debugging) - but don't fail
      console.log(`     ⚠️  Could not match embedded image URL: ${imageUrl.substring(0, 80)}...`)
    }
  }
  
  return mediaIds
}

/**
 * Get all media files from Strapi (called early for URL matching)
 */
let cachedAllMediaFiles = null

async function getAllMediaFiles() {
  if (cachedAllMediaFiles) {
    return cachedAllMediaFiles
  }
  
  try {
    const response = await strapiRequest(`/api/upload/files?pagination[limit]=10000`)
    
    // Response can be an array directly or wrapped in data property
    let files = Array.isArray(response) ? response : (response?.data || [])
    
    // Deduplicate by ID (in case pagination returned duplicates)
    const seenIds = new Set()
    const uniqueFiles = files.filter(file => {
      if (seenIds.has(file.id)) {
        return false
      }
      seenIds.add(file.id)
      return true
    })
    
    cachedAllMediaFiles = uniqueFiles
    return uniqueFiles
  } catch (error) {
    console.error(`❌ Error fetching media files:`, error.message)
    return []
  }
}

/**
 * Get all media IDs referenced in collection entries
 */
async function getAllUsedMediaIds() {
  console.log('📋 Step 1: Collecting all media IDs in use...\n')
  
  const usedMediaIds = new Set()
  
  // Check all collections with media fields
  for (const [collectionName, mediaFields] of Object.entries(COLLECTIONS_WITH_MEDIA)) {
    try {
      console.log(`   Checking ${collectionName}...`)
      // Fetch entries with all fields populated
      const entries = await getStrapiEntries(collectionName, {
        populate: '*', // Populate everything
      })
      
      console.log(`     Found ${entries.length} entries`)
      
      for (const entry of entries) {
        // Check each media field
        for (const fieldName of mediaFields) {
          const media = entry[fieldName]
          if (media) {
            if (Array.isArray(media)) {
              media.forEach(m => {
                // Media can be a number ID or an object with id property
                const mediaId = typeof m === 'number' ? m : (m?.id || m)
                if (mediaId) usedMediaIds.add(mediaId)
              })
            } else {
              // Media can be a number ID or an object with id property
              const mediaId = typeof media === 'number' ? media : (media?.id || media)
              if (mediaId) usedMediaIds.add(mediaId)
            }
          }
        }
      }
      
      // Count how many media IDs we found
      const foundBefore = usedMediaIds.size
      // This will be logged below, but let's count it
      const foundCount = usedMediaIds.size - foundBefore
      if (entries.length > 0) {
        console.log(`     Found ${usedMediaIds.size} unique media IDs so far`)
      }
    } catch (error) {
      console.log(`     ⚠️  Error checking ${collectionName}: ${error.message.substring(0, 100)}`)
    }
  }
  
  // Check richtext fields for embedded images
  // First, get all media files to match URLs from markdown
  console.log('   Fetching all media files for URL matching...')
  const allMediaFiles = await getAllMediaFiles()
  
  for (const [collectionName, richtextFields] of Object.entries(COLLECTIONS_WITH_RICHTEXT)) {
    if (richtextFields.length === 0) continue
    
    try {
      console.log(`   Checking ${collectionName} richtext fields...`)
      const entries = await getStrapiEntries(collectionName, {
        populate: false, // Don't need to populate for richtext
      })
      
      let richtextImageCount = 0
      for (const entry of entries) {
        for (const fieldName of richtextFields) {
          const richtext = entry[fieldName]
          if (richtext) {
            // Extract IDs from JSON format (if it's JSON)
            const jsonIds = extractMediaIdsFromRichtext(richtext)
            jsonIds.forEach(id => usedMediaIds.add(id))
            richtextImageCount += jsonIds.length
            
            // Extract IDs from Markdown format (if it's Markdown)
            const markdownIds = await extractMediaIdsFromMarkdownRichtext(richtext, allMediaFiles)
            markdownIds.forEach(id => usedMediaIds.add(id))
            richtextImageCount += markdownIds.length
          }
        }
      }
      
      console.log(`     Found ${entries.length} entries with richtext`)
      console.log(`     Found ${richtextImageCount} embedded images in richtext fields`)
    } catch (error) {
      console.log(`     ⚠️  Error checking ${collectionName} richtext: ${error.message.substring(0, 100)}`)
    }
  }
  
  console.log(`\n   ✅ Found ${usedMediaIds.size} media files in use\n`)
  return usedMediaIds
}

/**
 * Get all media files from Strapi (for deletion comparison)
 */
async function getAllMediaFilesForDeletion() {
  console.log('📋 Step 2: Fetching all media files from Strapi...\n')
  
  // Use cached version if available
  if (cachedAllMediaFiles) {
    console.log(`   Using cached media files: ${cachedAllMediaFiles.length} files`)
    return cachedAllMediaFiles
  }
  
  // Otherwise fetch fresh
  const files = await getAllMediaFiles()
  console.log(`   Fetched ${files.length} unique files`)
  return files
}

/**
 * Delete unused media files
 */
async function deleteUnusedMedia() {
  console.log('\n🗑️  Starting unused media cleanup...\n')
  
  try {
    // Step 1: Get all used media IDs
    const usedMediaIds = await getAllUsedMediaIds()
    
    // Step 2: Get all media files
    const allMedia = await getAllMediaFilesForDeletion()
    
    // Step 3: Find unused media
    const unusedMedia = allMedia.filter(file => !usedMediaIds.has(file.id))
    
    console.log(`📋 Step 3: Identifying unused media...\n`)
    console.log(`   Total media files: ${allMedia.length}`)
    console.log(`   Media in use: ${usedMediaIds.size}`)
    console.log(`   Unused media: ${unusedMedia.length}\n`)
    
    if (unusedMedia.length === 0) {
      console.log('✅ No unused media files found!')
      return
    }
    
    // Show preview of what will be deleted
    console.log('   Files to delete (first 10):')
    unusedMedia.slice(0, 10).forEach(file => {
      console.log(`     - ${file.name} (ID: ${file.id}, ${(file.size / 1024 / 1024).toFixed(2)}MB)`)
    })
    if (unusedMedia.length > 10) {
      console.log(`     ... and ${unusedMedia.length - 10} more`)
    }
    console.log('')
    
    // Confirm deletion
    console.log(`⚠️  About to delete ${unusedMedia.length} unused media files`)
    console.log('   Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n')
    await sleep(5000)
    
    // Step 4: Delete unused media
    console.log(`📋 Step 4: Deleting unused media...\n`)
    
    let deleted = 0
    let errors = 0
    
    for (let i = 0; i < unusedMedia.length; i++) {
      const file = unusedMedia[i]
      try {
        await strapiRequest(`/api/upload/files/${file.id}`, {
          method: 'DELETE',
        })
        console.log(`   ✅ [${i + 1}/${unusedMedia.length}] Deleted: ${file.name} (ID: ${file.id})`)
        deleted++
        
        // Small delay to avoid rate limiting
        if (i < unusedMedia.length - 1) {
          await sleep(300) // 300ms delay between deletions
        }
      } catch (error) {
        console.error(`   ❌ Error deleting ${file.name} (ID: ${file.id}):`, error.message.substring(0, 100))
        errors++
      }
    }
    
    console.log(`\n✅ Cleanup completed!`)
    console.log(`   Deleted: ${deleted}`)
    console.log(`   Errors: ${errors}`)
    console.log(`   Total unused: ${unusedMedia.length}`)
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error)
    throw error
  }
}

// Run if called directly
if (require.main === module) {
  deleteUnusedMedia()
    .then(() => {
      console.log('\n✅ Script completed successfully')
      process.exit(0)
    })
    .catch((error) => {
      console.error('\n💥 Script failed:', error)
      process.exit(1)
    })
}

module.exports = deleteUnusedMedia

