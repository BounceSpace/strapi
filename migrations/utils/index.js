/**
 * Migration utilities for Contentful to Strapi migration
 * 
 * This file contains helper functions for:
 * - Strapi API interactions
 * - Media uploads
 * - Field type mappings
 */

// Load environment variables from .env file if it exists
require('dotenv').config()

const { createClient } = require('contentful')
const { FormData, File } = require('formdata-node')
const fs = require('fs')
const https = require('https')
const http = require('http')
const path = require('path')
const sharp = require('sharp')

// Initialize Contentful client
const contentfulClient = createClient({
  space: 'bgnltbjvtgfi',
  accessToken: '9VwZRYtioR324miBRO9s51nGy3Zb3_Sh8Q5-RQCs4Q8',
  host: 'cdn.contentful.com',
})

// Strapi configuration - PRODUCTION ENVIRONMENT
const STRAPI_URL = process.env.STRAPI_URL || 'https://your-strapi-production-url.com'
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || 'your-api-token-here'

// Admin credentials for Content Type Builder API
// Option 1: Email/Password authentication
const STRAPI_ADMIN_EMAIL = process.env.STRAPI_ADMIN_EMAIL || ''
const STRAPI_ADMIN_PASSWORD = process.env.STRAPI_ADMIN_PASSWORD || ''
// Option 2: Direct admin API token (preferred for Strapi Cloud)
const STRAPI_ADMIN_TOKEN = process.env.STRAPI_ADMIN_TOKEN || ''
let adminJwtToken = null

/**
 * Authenticate with Strapi admin and get JWT token
 */
async function authenticateAdmin() {
  if (adminJwtToken) {
    return adminJwtToken
  }

  // If admin token is provided directly, use it
  if (STRAPI_ADMIN_TOKEN) {
    console.log('   Using provided admin API token...')
    adminJwtToken = STRAPI_ADMIN_TOKEN
    return adminJwtToken
  }

  // Otherwise, try email/password login
  if (!STRAPI_ADMIN_EMAIL || !STRAPI_ADMIN_PASSWORD) {
    throw new Error('Admin credentials not provided. Set either STRAPI_ADMIN_TOKEN or STRAPI_ADMIN_EMAIL + STRAPI_ADMIN_PASSWORD in .env')
  }

  try {
    console.log('   Authenticating with email/password...')
    const response = await fetch(`${STRAPI_URL}/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: STRAPI_ADMIN_EMAIL,
        password: STRAPI_ADMIN_PASSWORD,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      // Provide helpful error message
      if (response.status === 400) {
        throw new Error(`Invalid admin credentials. Please verify your email and password, or use STRAPI_ADMIN_TOKEN instead.`)
      }
      throw new Error(`Admin authentication failed (${response.status}): ${errorText}`)
    }

    const data = await response.json()
    adminJwtToken = data.data?.token || data.token
    
    if (!adminJwtToken) {
      throw new Error('No token received from admin login response')
    }
    
    return adminJwtToken
  } catch (error) {
    throw new Error(`Failed to authenticate admin: ${error.message}`)
  }
}

/**
 * Make API request to Strapi
 */
async function strapiRequest(endpoint, options = {}) {
  const url = `${STRAPI_URL}${endpoint}`
  const defaultOptions = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${STRAPI_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }

  // Remove Content-Type for FormData (will be set automatically)
  // formdata-node doesn't have getHeaders() - it handles headers automatically
  if (options.body instanceof FormData) {
    delete defaultOptions.headers['Content-Type']
  }

  const response = await fetch(url, defaultOptions)
  
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Strapi API error (${response.status}): ${errorText}`)
  }

  // Handle empty responses (e.g., DELETE requests)
  const contentType = response.headers.get('content-type')
  if (!contentType || !contentType.includes('application/json')) {
    return null
  }

  const text = await response.text()
  if (!text) {
    return null
  }

  return JSON.parse(text)
}

/**
 * Upload a media file to Strapi and optionally attach it to an entry
 * @param {Object} asset - Contentful asset object
 * @param {string} fieldName - Field name in Strapi
 * @param {Object} options - Options for attaching to entry: { ref, refId, entryId }
 * @returns {Promise<number|{id:number,sizeMB:number}|null>} - Strapi file ID (or object with id and sizeMB for large files) or null if failed
 */
async function uploadMediaToStrapi(asset, fieldName = 'file', options = {}) {
  if (!asset || !asset.fields || !asset.fields.file) {
    console.log(`⚠️  No asset data for ${fieldName}, skipping...`)
    return null
  }

  const fileUrl = `https:${asset.fields.file.url}`
  const fileName = asset.fields.file.fileName
  const contentType = asset.fields.file.contentType
  let tempFilePath = null
  let finalFilePath = null // Initialize here for error cleanup
  let downloadStartTime = Date.now() // Initialize here for error cleanup
  // Define retry constants here so they're available in catch block
  const maxRetries = 3 // Reduced from 5 - fail faster if server is overloaded
  const baseDelayMs = 3000 // Base delay: 3 seconds
  const maxDelayMs = 30000 // Cap delays at 30 seconds max (reduced from 60s)

  try {
    console.log(`📤 [${fieldName}] Starting upload: ${fileName}`)

    // Download file to temporary location
    const tempDir = path.join(process.cwd(), '.temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    tempFilePath = path.join(tempDir, fileName)

    // Download file
    console.log(`   ⬇️  Downloading from Contentful...`)
    downloadStartTime = Date.now()
    await new Promise((resolve, reject) => {
      const protocol = fileUrl.startsWith('https') ? https : http
      const file = fs.createWriteStream(tempFilePath)
      
      protocol.get(fileUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          protocol.get(response.headers.location, (redirectResponse) => {
            redirectResponse.pipe(file)
            file.on('finish', () => {
              file.close(resolve)
            })
          }).on('error', reject)
        } else {
          response.pipe(file)
          file.on('finish', () => {
            file.close(resolve)
          })
        }
      }).on('error', (err) => {
        fs.unlink(tempFilePath, () => {})
        reject(err)
      })
    })
    const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(1)
    console.log(`   ✅ Downloaded in ${downloadTime}s`)

    // Check file size before compression
    const fileStats = fs.statSync(tempFilePath)
    const originalSizeMB = fileStats.size / 1024 / 1024
    
    // Compress images based on size:
    // - > 10MB: quality 0.85 (85) - target 3-5MB range
    // - 5-10MB: quality 0.9 (90) - lighter compression
    // - 1-5MB: quality 0.95 (95) - very light compression
    // - < 1MB: no compression
    let finalFilePath = tempFilePath
    let fileSizeMB = originalSizeMB
    let wasCompressed = false
    
    if (fileSizeMB >= 1 && contentType && contentType.startsWith('image/')) {
      try {
        // Determine compression quality based on file size
        let compressionQuality = 95 // Default for 1-5MB range
        let qualityDescription = 'very high quality (0.95)'
        
        if (fileSizeMB > 10) {
          compressionQuality = 85 // Higher compression for > 10MB
          qualityDescription = 'high quality (0.85) - aggressive compression'
          console.log(`   🔧 Compression needed: ${originalSizeMB.toFixed(2)}MB exceeds 10MB threshold`)
          console.log(`   🔧 Target: compress to 3-5MB range with ${qualityDescription}...`)
        } else if (fileSizeMB >= 5 && fileSizeMB <= 10) {
          compressionQuality = 90 // Medium compression for 5-10MB
          qualityDescription = 'high quality (0.9)'
          console.log(`   🔧 Compression needed: ${originalSizeMB.toFixed(2)}MB is between 5-10MB`)
          console.log(`   🔧 Applying lighter compression with ${qualityDescription}...`)
        } else {
          // 1-5MB range
          console.log(`   🔧 Compression needed: ${originalSizeMB.toFixed(2)}MB is between 1-5MB`)
          console.log(`   🔧 Applying very light compression with ${qualityDescription}...`)
        }
        
        // Use sharp to compress
        const compressionStartTime = Date.now()
        const image = sharp(tempFilePath)
        const metadata = await image.metadata()
        console.log(`   📐 Image dimensions: ${metadata.width}x${metadata.height}, format: ${metadata.format || 'unknown'}`)
        
        // Calculate target dimensions if needed (maintain aspect ratio)
        // For files > 10MB, we may need to resize slightly and compress
        let targetWidth = metadata.width
        let targetHeight = metadata.height
        
        // If image is very large in dimensions, scale down proportionally
        // Resize rules based on file size:
        // - > 10MB: resize if > 3000px
        // - 5-10MB: resize only if > 4000px
        // - 1-5MB: resize only if > 5000px (preserve more detail)
        if (fileSizeMB > 10 && (metadata.width > 3000 || metadata.height > 3000)) {
          if (metadata.width > metadata.height) {
            targetWidth = 3000
            targetHeight = Math.round((3000 / metadata.width) * metadata.height)
          } else {
            targetHeight = 3000
            targetWidth = Math.round((3000 / metadata.height) * metadata.width)
          }
          console.log(`   🔧 Resizing: ${metadata.width}x${metadata.height} -> ${targetWidth}x${targetHeight}`)
        } else if (fileSizeMB >= 5 && fileSizeMB <= 10 && (metadata.width > 4000 || metadata.height > 4000)) {
          // For 5-10MB files, only resize if dimensions are very large (> 4000px)
          if (metadata.width > metadata.height) {
            targetWidth = 4000
            targetHeight = Math.round((4000 / metadata.width) * metadata.height)
          } else {
            targetHeight = 4000
            targetWidth = Math.round((4000 / metadata.height) * metadata.width)
          }
          console.log(`   🔧 Resizing: ${metadata.width}x${metadata.height} -> ${targetWidth}x${targetHeight}`)
        } else if (fileSizeMB >= 1 && fileSizeMB < 5 && (metadata.width > 5000 || metadata.height > 5000)) {
          // For 1-5MB files, only resize if dimensions are extremely large (> 5000px)
          if (metadata.width > metadata.height) {
            targetWidth = 5000
            targetHeight = Math.round((5000 / metadata.width) * metadata.height)
          } else {
            targetHeight = 5000
            targetWidth = Math.round((5000 / metadata.height) * metadata.width)
          }
          console.log(`   🔧 Resizing: ${metadata.width}x${metadata.height} -> ${targetWidth}x${targetHeight}`)
        }
        
        // Compressed file path
        const compressedFilePath = tempFilePath.replace(/(\.\w+)$/, '_compressed$1')
        
        // Compress based on image format
        // JPEG for most images
        // PNG compression for PNGs (preserves transparency)
        const isPNG = metadata.format === 'png'
        
        if (isPNG) {
          // Compress PNG while preserving transparency
          await image
            .resize(targetWidth, targetHeight, {
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png({
              quality: compressionQuality,
              compressionLevel: 9, // Maximum compression for PNG
              adaptiveFiltering: true,
            })
            .toFile(compressedFilePath)
        } else {
          // Compress with high quality JPEG settings
          // Progressive JPEG for better perceived quality
          await image
            .resize(targetWidth, targetHeight, {
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({
              quality: compressionQuality,
              progressive: true,
              mozjpeg: true, // Use mozjpeg encoder for better compression
            })
            .toFile(compressedFilePath)
        }
        
        // Check compressed file size
        const compressionTime = ((Date.now() - compressionStartTime) / 1000).toFixed(1)
        const compressedStats = fs.statSync(compressedFilePath)
        const compressedSizeMB = compressedStats.size / 1024 / 1024
        
        if (compressedSizeMB < originalSizeMB) {
          // Only use compressed version if it's actually smaller
          finalFilePath = compressedFilePath
          fileSizeMB = compressedSizeMB
          wasCompressed = true
          const reduction = ((originalSizeMB - compressedSizeMB) / originalSizeMB * 100).toFixed(1)
          console.log(`   ✅ Compression complete (${compressionTime}s): ${originalSizeMB.toFixed(2)}MB -> ${compressedSizeMB.toFixed(2)}MB (${reduction}% reduction)`)
          
          // Clean up original if we have compressed version
          if (tempFilePath !== compressedFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath)
          }
        } else {
          // Compressed version wasn't smaller, use original
          if (fs.existsSync(compressedFilePath)) {
            fs.unlinkSync(compressedFilePath)
          }
          console.log(`   ℹ️  Compression didn't reduce size (${compressionTime}s), using original`)
        }
      } catch (compressionError) {
        console.log(`   ⚠️  Compression failed, using original: ${compressionError.message.substring(0, 100)}`)
        // Continue with original file
        finalFilePath = tempFilePath
      }
    }
    
    // Sanitize filename (remove special characters that might cause issues)
    let sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    
    // Update content type if we compressed (preserve PNG, convert others to JPEG)
    let finalContentType = contentType
    if (wasCompressed && contentType && contentType.startsWith('image/')) {
      const image = sharp(finalFilePath)
      const compressedMetadata = await image.metadata()
      
      if (compressedMetadata.format === 'png') {
        finalContentType = 'image/png'
        // Keep PNG extension
        if (!sanitizedFileName.toLowerCase().endsWith('.png')) {
          const nameWithoutExt = sanitizedFileName.replace(/\.[^/.]+$/, '')
          sanitizedFileName = `${nameWithoutExt}.png`
        }
      } else {
        finalContentType = 'image/jpeg'
        // Update filename extension to .jpg if it wasn't already
        if (!sanitizedFileName.toLowerCase().endsWith('.jpg') && !sanitizedFileName.toLowerCase().endsWith('.jpeg')) {
          const nameWithoutExt = sanitizedFileName.replace(/\.[^/.]+$/, '')
          sanitizedFileName = `${nameWithoutExt}.jpg`
        }
      }
    }
    
    if (fileSizeMB > 10) {
      console.log(`   ⚠️  Large file detected: ${fileSizeMB.toFixed(2)}MB - will use retry logic`)
    }
    
    // Read file as buffer once - we'll reuse it for retries
    const fileBuffer = fs.readFileSync(finalFilePath)
    
    // Retry logic with exponential backoff
    // Reduced retries and delays to prevent extremely long waits
    let lastError = null
    
    console.log(`   📊 Upload config: maxRetries=${maxRetries}, fileSize=${fileSizeMB.toFixed(2)}MB, compressed=${wasCompressed ? 'yes' : 'no'}`)
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let timeoutId = null
      let controller = null
      
      if (attempt > 1) {
        console.log(`   🔄 Retry attempt ${attempt}/${maxRetries} for ${fileName}...`)
      } else {
        console.log(`   🚀 Upload attempt ${attempt}/${maxRetries}...`)
      }
      
      const uploadAttemptStartTime = Date.now()
      
      try {
        // Upload to Strapi
        const formData = new FormData()
        
        // If attaching to an entry, add ref, refId, and field as form fields
        // Per Strapi docs: these should be in the form body along with the file
        if (options.ref && options.refId && options.field) {
          formData.append('ref', options.ref)
          formData.append('refId', options.refId.toString())
          formData.append('field', options.field)
        }
        
                // Create File with proper options - ensure lastModified is set
                // According to formdata-node docs, File constructor signature: File(bits, name[, options])
                const file = new File([fileBuffer], sanitizedFileName, { 
                  type: finalContentType || 'application/octet-stream',
                  lastModified: Date.now()
                })
        
        // Append file - formdata-node append signature: append(name, value, filename?)
        formData.append('files', file)

        // Use admin token if available, otherwise fall back to API token
        let uploadToken = STRAPI_API_TOKEN
        if (STRAPI_ADMIN_TOKEN) {
          uploadToken = STRAPI_ADMIN_TOKEN
        }
        
        const uploadUrl = `${STRAPI_URL}/api/upload`
        
        // For large files, increase timeout (calculate based on file size: ~1MB per second upload time)
        // Cap at 2 minutes (120000ms) to prevent extremely long waits - if upload takes longer, it's likely failed
        // Minimum 30 seconds, plus 3 seconds per MB for files over 5MB
        const estimatedUploadTime = Math.min(120000, fileSizeMB > 5 ? 30000 + (fileSizeMB * 3000) : 30000)
        console.log(`   ⏱️  Upload timeout set to ${(estimatedUploadTime/1000).toFixed(0)}s (estimated for ${fileSizeMB.toFixed(2)}MB file)`)
        
        // Use AbortController for timeout (Node 18+)
        controller = new AbortController()
        timeoutId = setTimeout(() => {
          console.log(`   ⚠️  Upload timeout after ${(estimatedUploadTime/1000).toFixed(0)}s, aborting...`)
          controller.abort()
        }, estimatedUploadTime)
        
        try {
          console.log(`   🌐 Sending POST request to Strapi...`)
          const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${uploadToken}`,
            },
            body: formData,
            signal: controller.signal,
          })
          
          const uploadTime = ((Date.now() - uploadAttemptStartTime) / 1000).toFixed(1)
          
          if (timeoutId) {
            clearTimeout(timeoutId)
            timeoutId = null
          }

          console.log(`   📡 Response received (${uploadTime}s): status ${response.status}`)

          if (!response.ok) {
            const errorText = await response.text()
            
            // Check if it's a retryable error (5xx server errors, 504 Gateway Timeout, 503 Service Unavailable)
            const isRetryable = response.status >= 500 || response.status === 504 || response.status === 503
            
            if (isRetryable && attempt < maxRetries) {
              // Calculate exponential backoff delay with cap
              const delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1))
              console.log(`   ❌ Upload failed: HTTP ${response.status} (${errorText.substring(0, 100)})`)
              console.log(`   ⏳ Waiting ${(delayMs/1000).toFixed(1)}s before retry ${attempt + 1}/${maxRetries}...`)
              await sleep(delayMs)
              continue // Retry - this will increment attempt and loop again
            }
            
            throw new Error(`Strapi upload error (${response.status}): ${errorText.substring(0, 200)}`)
          }

          const uploadResponse = await response.json()

          if (uploadResponse && uploadResponse.length > 0) {
            const uploadedId = uploadResponse[0].id
            const totalUploadTime = ((Date.now() - uploadAttemptStartTime) / 1000).toFixed(1)
            if (attempt > 1) {
              console.log(`   ✅ Upload SUCCESS on attempt ${attempt}/${maxRetries} (${totalUploadTime}s total)`)
              console.log(`   ✅ File ID: ${uploadedId}, Size: ${fileSizeMB.toFixed(2)}MB`)
            } else {
              console.log(`   ✅ Upload SUCCESS on first attempt (${totalUploadTime}s)`)
              console.log(`   ✅ File ID: ${uploadedId}, Size: ${fileSizeMB.toFixed(2)}MB`)
            }
            
            // Clean up temp files on success
            if (fs.existsSync(tempFilePath)) {
              try {
                fs.unlinkSync(tempFilePath)
              } catch (e) {
                // Ignore cleanup errors
              }
            }
            if (finalFilePath !== tempFilePath && fs.existsSync(finalFilePath)) {
              try {
                fs.unlinkSync(finalFilePath)
              } catch (e) {
                // Ignore cleanup errors
              }
            }
            
            // Return ID and file size info for delay calculation
            return { id: uploadedId, sizeMB: fileSizeMB }
          }

          throw new Error('Upload response empty or invalid')
        } catch (fetchError) {
          if (timeoutId) {
            clearTimeout(timeoutId)
            timeoutId = null
          }
          
          // Check if it's a timeout/abort error
          const isTimeout = fetchError.name === 'AbortError' || fetchError.message?.includes('aborted')
          const isRetryable = isTimeout || (fetchError.message && (
            fetchError.message.includes('504') ||
            fetchError.message.includes('503') ||
            fetchError.message.includes('502') ||
            fetchError.message.includes('ECONNRESET') ||
            fetchError.message.includes('ETIMEDOUT')
          ))
          
          if (isRetryable && attempt < maxRetries) {
            // Calculate exponential backoff delay with cap
                    const delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1))
                    const errorMsg = isTimeout 
                      ? `timeout after ${estimatedUploadTime/1000}s (${fileSizeMB.toFixed(2)}MB file)`
                      : fetchError.message?.substring(0, 100) || 'unknown error'
                    console.log(`   ❌ Upload failed: ${errorMsg}`)
                    console.log(`   ⏳ Waiting ${(delayMs/1000).toFixed(1)}s before retry ${attempt + 1}/${maxRetries}...`)
                    lastError = fetchError
                    await sleep(delayMs)
                    continue // Retry - this will increment attempt and loop again
          }
          
          // Not retryable or last attempt - throw to exit loop
          throw fetchError
        }
      } catch (error) {
        // Ensure timeout is cleared
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
        
        lastError = error
        
        // Check if error is retryable (even for outer catch errors)
        const isRetryable = error.message && (
          error.message.includes('504') ||
          error.message.includes('503') ||
          error.message.includes('502') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('timeout') ||
          error.name === 'AbortError'
        )
        
        // If this is the last attempt OR not retryable, throw to exit loop
        if (attempt >= maxRetries || !isRetryable) {
          throw error
        }
        
                // Otherwise, retry with exponential backoff
                const delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1))
                console.log(`   ❌ Upload error: ${error.message?.substring(0, 100) || 'unknown error'}`)
                console.log(`   ⏳ Waiting ${(delayMs/1000).toFixed(1)}s before retry ${attempt + 1}/${maxRetries}...`)
                await sleep(delayMs)
                continue // Retry - increment attempt and loop again
      }
    }
    
    // This should never be reached, but just in case
    throw lastError || new Error(`Failed to upload ${fileName} after ${maxRetries} attempts`)
  } catch (error) {
    // Clean up temp files on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (finalFilePath && finalFilePath !== tempFilePath && fs.existsSync(finalFilePath)) {
      try {
        fs.unlinkSync(finalFilePath)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    const totalTime = ((Date.now() - downloadStartTime) / 1000).toFixed(1)
    console.error(`   ❌ Upload FAILED after ${maxRetries} attempts (total time: ${totalTime}s)`)
    console.error(`   ❌ Final error: ${error.message.substring(0, 200)}`)
    return null
  }
}

/**
 * Upload multiple media files to Strapi
 */
async function uploadMultipleMediaToStrapi(assets, fieldName = 'files') {
  if (!assets || !Array.isArray(assets) || assets.length === 0) {
    return []
  }

  const uploadPromises = assets.map(asset => uploadMediaToStrapi(asset, fieldName))
  const results = await Promise.all(uploadPromises)
  return results.filter(id => id !== null)
}

/**
 * Create a content type entry in Strapi
 * @param {string} contentType - Strapi content type (e.g., 'space-tag', 'space')
 * @param {Object} data - Entry data
 * @returns {Promise<Object>} - Created entry
 */
async function createStrapiEntry(pluralName, data) {
  console.log(`📝 Creating ${pluralName} entry: ${data.title || data.slug || 'untitled'}...`)
  
  try {
    // Try Content Manager API first (Strapi v5)
    // Note: Content Manager API uses singular form: api::{singular}.{singular}
    // We derive singular from plural (remove trailing 's' for most cases)
    const singularName = pluralName.endsWith('s') ? pluralName.slice(0, -1) : pluralName
    
    let response
    try {
      // Content Manager API format for Strapi v5
      const cmApiUrl = `/content-manager/collection-types/api::${singularName}.${singularName}`
      response = await strapiRequest(cmApiUrl, {
        method: 'POST',
        body: JSON.stringify({ data }),
      })
      console.log(`✅ Created ${pluralName} entry via Content Manager API (ID: ${response.data?.id || response.id})`)
      return response.data || response
    } catch (cmError) {
      // Fallback to REST API (uses plural form)
      console.log(`  ⚠️  Content Manager API failed, trying REST API...`)
      response = await strapiRequest(`/api/${pluralName}`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      })
      console.log(`✅ Created ${pluralName} entry via REST API (ID: ${response.data.id})`)
      return response.data
    }
  } catch (error) {
    console.error(`❌ Error creating ${pluralName} entry:`, error.message)
    // Provide more helpful error message
    if (error.message.includes('404')) {
      console.error(`   💡 Hint: Content type "${pluralName}" might not exist or API access is not enabled.`)
      console.error(`   💡 Check Strapi admin: Settings → Content-Types → ${pluralName} → Settings → API → Enable REST API`)
    }
    throw error
  }
}

/**
 * Update a content type entry in Strapi
 */
async function updateStrapiEntry(contentType, id, data) {
  try {
    const response = await strapiRequest(`/api/${contentType}/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    })
    return response.data
  } catch (error) {
    console.error(`❌ Error updating ${contentType} entry:`, error.message)
    throw error
  }
}

/**
 * Get existing entries from Strapi
 */
async function getStrapiEntries(contentType, options = {}) {
  try {
    const queryParams = new URLSearchParams()
    
    // Handle filters in Strapi v5 format: filters[field][$eq]=value
    if (options.filters) {
      Object.entries(options.filters).forEach(([key, value]) => {
        if (typeof value === 'object' && value.$eq !== undefined) {
          queryParams.append(`filters[${key}][$eq]`, value.$eq)
        } else {
          queryParams.append(`filters[${key}]`, value)
        }
      })
    }
    
    // Handle pagination
    if (options._limit) {
      queryParams.append('pagination[limit]', options._limit)
    }
    if (options._start) {
      queryParams.append('pagination[start]', options._start)
    }
    
    // Handle populate for relations and media
    if (options.populate) {
      if (Array.isArray(options.populate)) {
        // Array format: ['field1', 'field2'] -> populate[field1]=*&populate[field2]=*
        options.populate.forEach(field => queryParams.append(`populate[${field}]`, '*'))
      } else if (typeof options.populate === 'string') {
        queryParams.append('populate', options.populate)
      } else if (typeof options.populate === 'object') {
        // Object format: {field1: true, field2: true} -> populate[field1]=*&populate[field2]=*
        Object.entries(options.populate).forEach(([key, value]) => {
          if (value === true) {
            queryParams.append(`populate[${key}]`, '*')
          }
        })
      }
    }
    
    const query = queryParams.toString()
    const endpoint = `/api/${contentType}${query ? `?${query}` : ''}`
    
    const response = await strapiRequest(endpoint)
    return response.data || []
  } catch (error) {
    // Don't log 500 errors for getStrapiEntries - they might be expected (e.g., filter syntax issues)
    if (!error.message.includes('500')) {
      console.error(`❌ Error fetching ${contentType} entries:`, error.message)
    }
    return []
  }
}

/**
 * Check if a content type exists in Strapi
 */
async function contentTypeExists(contentType) {
  try {
    // Try to get the content type schema
    const response = await strapiRequest(`/api/content-type-builder/content-types/api::${contentType}.${contentType}`)
    return response && response.data !== null
  } catch (error) {
    if (error.message.includes('404') || error.message.includes('Not Found')) {
      return false
    }
    // Other errors, assume it doesn't exist or can't check
    return false
  }
}

/**
 * Create a content type in Strapi via Admin API (Content Type Builder)
 * @param {string} contentType - Content type identifier (e.g., 'space-tag')
 * @param {string} pluralName - Plural name for the content type
 * @param {Object} schema - Content type schema object
 * @returns {Promise<Object>}
 */
async function createStrapiContentType(contentType, pluralName, schema) {
  console.log(`🔨 Creating content type via Admin API: ${contentType}...`)
  
  try {
    // Authenticate as admin
    const adminToken = await authenticateAdmin()
    
    // Try both endpoints - Strapi v5 might use different paths
    const endpoints = [
      '/content-type-builder/content-types',
      '/api/content-type-builder/content-types',
    ]
    
    // Prepare the schema payload
    const payload = schema.contentType
    const requestBody = { contentType: payload }
    
    let lastError = null
    
    for (const endpoint of endpoints) {
      try {
        const url = `${STRAPI_URL}${endpoint}`
        
        console.log(`   Trying endpoint: ${endpoint}...`)
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        })

        const responseText = await response.text()
        
        if (response.ok) {
          const data = JSON.parse(responseText)
          console.log(`✅ Content type "${contentType}" created successfully via Admin API`)
          
          // Wait a moment for Strapi to process and rebuild
          console.log('   Waiting for Strapi to rebuild...')
          await sleep(3000)
          
          return data
        } else {
          // Check if content type already exists
          if (response.status === 400 && (responseText.includes('already exists') || responseText.includes('duplicate'))) {
            console.log(`   ⚠️  Content type may already exist, continuing...`)
            return { exists: true }
          }
          
          lastError = `Strapi Admin API error (${response.status}): ${responseText.substring(0, 200)}`
          
          // If 405, try next endpoint
          if (response.status === 405) {
            console.log(`   ⚠️  Method not allowed on ${endpoint}, trying next...`)
            continue
          }
          
          // If 401, the token might not have permissions
          if (response.status === 401) {
            console.log(`   ⚠️  401 Unauthorized - token may not have Content Type Builder permissions`)
            console.log(`   💡 Note: Content Type Builder API might not be available via REST API in Strapi Cloud`)
            console.log(`   💡 Consider creating content types manually in Strapi admin, then run migrations for entries only`)
            throw new Error(lastError)
          }
        }
      } catch (error) {
        lastError = error.message
        continue
      }
    }
    
    // If we get here, all endpoints failed
    throw new Error(lastError || 'All endpoints failed')
  } catch (error) {
    console.error(`❌ Error creating content type "${contentType}":`, error.message)
    console.error(`   💡 Content Type Builder API might be restricted in Strapi Cloud/v5`)
    console.error(`   💡 Alternative: Create content types manually in Strapi admin panel first`)
    throw error
  }
}

/**
 * Map Contentful text field to Strapi
 */
function mapText(contentfulValue) {
  return contentfulValue || null
}

/**
 * Map Contentful rich text field to Strapi Rich Text (Blocks)
 * Note: This is a simplified mapping. Rich text in Contentful may need
 * special handling for embedded entries/assets
 */
function mapRichText(contentfulRichText) {
  // For now, convert to plain text or structured format
  // You may need to implement proper rich text conversion based on Strapi's format
  if (!contentfulRichText) return null
  
  // Strapi Rich Text uses Blocks format
  // This is a placeholder - adjust based on your Strapi version and requirements
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: JSON.stringify(contentfulRichText),
          },
        ],
      },
    ],
  }
}

/**
 * Map Contentful number field to Strapi
 */
function mapNumber(contentfulValue) {
  return contentfulValue !== undefined && contentfulValue !== null ? Number(contentfulValue) : null
}

/**
 * Map Contentful date/time field to Strapi
 */
function mapDate(contentfulValue) {
  return contentfulValue || null
}

/**
 * Map Contentful boolean field to Strapi
 */
function mapBoolean(contentfulValue) {
  return contentfulValue === true || contentfulValue === 'true'
}

/**
 * Map Contentful location field to Strapi (as JSON or separate fields)
 */
function mapLocation(contentfulLocation) {
  if (!contentfulLocation) return null
  
  return {
    lat: contentfulLocation.lat,
    lon: contentfulLocation.lon,
  }
}

/**
 * Map Contentful reference(s) to Strapi relation IDs
 * @param {Array|Object} contentfulReferences - Contentful reference(s)
 * @param {Map} idMapping - Map of Contentful IDs to Strapi IDs
 * @returns {Array|number|null} - Strapi ID(s)
 */
function mapReference(contentfulReferences, idMapping) {
  if (!contentfulReferences) return null
  
  if (Array.isArray(contentfulReferences)) {
    const strapiIds = contentfulReferences
      .map(ref => {
        const contentfulId = ref.sys?.id
        return contentfulId ? idMapping.get(contentfulId) : null
      })
      .filter(id => id !== null)
    
    return strapiIds.length > 0 ? strapiIds : null
  } else {
    // Single reference
    const contentfulId = contentfulReferences.sys?.id
    return contentfulId ? idMapping.get(contentfulId) : null
  }
}

/**
 * Converts Contentful Rich Text JSON to Strapi's Markdown format.
 * Strapi Rich Text stores content as Markdown text (WYSIWYG), not JSON blocks.
 * Handles paragraphs, headings, embedded assets, lists, blockquotes, and basic text formatting.
 * @param {Object} contentfulRichText - The Contentful Rich Text JSON object.
 * @param {Object} strapiAssetMap - A map of Contentful asset ID to {id: mediaId, url: mediaUrl, fileName: fileName}.
 * @returns {string} Markdown text string for Strapi Rich Text field.
 */
function convertContentfulRichTextToStrapi(contentfulRichText, strapiAssetMap = {}) {
  if (!contentfulRichText || !contentfulRichText.content) {
    return ''
  }

  const markdownLines = []

  function processNode(node) {
    switch (node.nodeType) {
      case 'document':
        // Process all content nodes
        if (node.content) {
          node.content.forEach(child => processNode(child))
        }
        break

      case 'paragraph':
        const paragraphText = []
        if (node.content) {
          node.content.forEach((child, index) => {
            if (child.nodeType === 'text') {
              const originalText = child.value || ''
              // Preserve leading and trailing whitespace from Contentful
              // These spaces are part of the structure between text nodes
              const leadingSpace = originalText.match(/^\s*/)?.[0] || ''
              const trailingSpace = originalText.match(/\s*$/)?.[0] || ''
              const trimmedText = originalText.trim()
              
              if (!trimmedText && !leadingSpace && !trailingSpace) {
                // Truly empty node - skip it
                return
              }
              
              // If only whitespace, preserve it as a space
              if (!trimmedText && (leadingSpace || trailingSpace)) {
                paragraphText.push(' ')
                return
              }
              
              // Handle marks (bold, italic, etc.) - only apply to trimmed content
              const marks = child.marks || []
              const sortedMarks = [...marks].sort((a, b) => {
                const order = { 'bold': 1, 'italic': 2, 'code': 3 }
                return (order[a.type] || 99) - (order[b.type] || 99)
              })
              
              let formattedText = trimmedText
              sortedMarks.forEach(mark => {
                if (mark.type === 'bold') {
                  // Ensure no spaces inside bold markers
                  formattedText = `**${formattedText.trim()}**`
                } else if (mark.type === 'italic') {
                  // Ensure no spaces inside italic markers
                  formattedText = `*${formattedText.trim()}*`
                } else if (mark.type === 'code') {
                  formattedText = `\`${formattedText.trim()}\``
                }
              })
              
              // Reconstruct with preserved whitespace: leadingSpace + formattedText + trailingSpace
              paragraphText.push(leadingSpace + formattedText + trailingSpace)
            } else if (child.nodeType === 'hyperlink') {
              // Handle hyperlinks within paragraphs
              const linkText = (child.content?.[0]?.value || '').trim()
              const linkUrl = child.data?.uri || ''
              if (linkText && linkUrl) {
                paragraphText.push(`[${linkText}](${linkUrl})`)
              }
            }
          })
        }
        if (paragraphText.length > 0) {
          // Join paragraph parts - don't add extra spaces, preserve the ones from Contentful
          let paragraphContent = paragraphText.join('')
          
          // Now clean up: ensure no spaces INSIDE markdown markers (but keep spaces BETWEEN markers)
          // Pattern: `** text **` -> `**text**` (spaces inside markers)
          paragraphContent = paragraphContent.replace(/\*\* +([^*]+?) +\*\*/g, '**$1**') // Bold: remove spaces inside
          // For italic, need to match `* text *` but not `**text**`
          // Use negative lookbehind/lookahead to ensure we're not matching part of bold
          paragraphContent = paragraphContent.replace(/(?<!\*)\* +([^*]+?) +\*(?!\*)/g, '*$1*') // Italic: remove spaces inside
          
          // Collapse multiple spaces into single space
          paragraphContent = paragraphContent.replace(/\s{2,}/g, ' ').trim()
          
          if (paragraphContent) {
            markdownLines.push(paragraphContent)
          }
        }
        break

      case 'heading-1':
      case 'heading-2':
      case 'heading-3':
      case 'heading-4':
      case 'heading-5':
      case 'heading-6':
        let level = parseInt(node.nodeType.replace('heading-', ''))
        // Strapi only supports h1-h4, so map heading-5 and heading-6 to h4
        if (level > 4) {
          level = 4
        }
        const headingParts = []
        if (node.content) {
          node.content.forEach(child => {
            if (child.nodeType === 'text') {
              let text = (child.value || '').trim() // Trim whitespace
              // Skip empty text nodes
              if (!text) return
              
              // Handle marks (bold, italic, etc.) in headings
              if (child.marks && child.marks.length > 0) {
                const marks = child.marks || []
                const sortedMarks = [...marks].sort((a, b) => {
                  const order = { 'bold': 1, 'italic': 2, 'code': 3 }
                  return (order[a.type] || 99) - (order[b.type] || 99)
                })
                
                sortedMarks.forEach(mark => {
                  if (mark.type === 'bold') {
                    text = `**${text.trim()}**`
                  } else if (mark.type === 'italic') {
                    text = `*${text.trim()}*`
                  } else if (mark.type === 'code') {
                    text = `\`${text.trim()}\``
                  }
                })
              }
              headingParts.push(text)
            } else if (child.nodeType === 'hyperlink') {
              // Handle hyperlinks within headings (e.g., "Text: [Link](url)")
              const linkTextNode = child.content?.[0]
              const linkText = linkTextNode ? (linkTextNode.value || '').trim() : ''
              const linkUrl = child.data?.uri || ''
              if (linkText && linkUrl) {
                headingParts.push(`[${linkText}](${linkUrl})`)
              } else if (linkUrl && !linkText) {
                // Fallback: use URL as link text if no text provided
                headingParts.push(`[${linkUrl}](${linkUrl})`)
              }
            }
          })
        }
        if (headingParts.length > 0) {
          const headingPrefix = '#'.repeat(level)
          // Join with space, clean up spaces inside markers, then collapse multiple spaces
          let headingContent = headingParts.join(' ')
          headingContent = headingContent.replace(/\*\* +([^*]+?) +\*\*/g, '**$1**') // Bold
          headingContent = headingContent.replace(/\* +([^*]+?) +\*/g, '*$1*') // Italic
          headingContent = headingContent.replace(/\s+/g, ' ').trim()
          markdownLines.push(`${headingPrefix} ${headingContent}`)
        }
        break

      case 'embedded-asset-block':
        // This is an embedded image - convert to markdown image syntax: ![alt](url)
        const assetId = node.data?.target?.sys?.id
        if (assetId && strapiAssetMap[assetId]) {
          const assetInfo = strapiAssetMap[assetId]
          const fileName = assetInfo.fileName || `image-${assetInfo.id}`
          const imageUrl = assetInfo.url || ''
          if (imageUrl) {
            markdownLines.push(`![${fileName}](${imageUrl})`)
          } else {
            console.log(`     ⚠️  Embedded asset ${assetId} has no URL`)
          }
        } else {
          console.log(`     ⚠️  Embedded asset ${assetId} not found or not uploaded`)
        }
        break

      case 'unordered-list':
      case 'ordered-list':
        const isOrdered = node.nodeType === 'ordered-list'
        let listCounter = 1
        if (node.content) {
          node.content.forEach(listItem => {
            if (listItem.nodeType === 'list-item' && listItem.content) {
              const itemParts = []
              listItem.content.forEach(para => {
                if (para.nodeType === 'paragraph' && para.content) {
                  para.content.forEach(text => {
                    if (text.nodeType === 'text') {
                      let textValue = (text.value || '').trim()
                      if (!textValue) return
                      
                      // Handle marks in list items
                      if (text.marks && text.marks.length > 0) {
                        const marks = text.marks || []
                        const sortedMarks = [...marks].sort((a, b) => {
                          const order = { 'bold': 1, 'italic': 2, 'code': 3 }
                          return (order[a.type] || 99) - (order[b.type] || 99)
                        })
                        
                        sortedMarks.forEach(mark => {
                          if (mark.type === 'bold') {
                            textValue = `**${textValue.trim()}**`
                          } else if (mark.type === 'italic') {
                            textValue = `*${textValue.trim()}*`
                          } else if (mark.type === 'code') {
                            textValue = `\`${textValue.trim()}\``
                          }
                        })
                      }
                      itemParts.push(textValue)
                    } else if (text.nodeType === 'hyperlink') {
                      // Handle hyperlinks in list items
                      const linkText = (text.content?.[0]?.value || '').trim()
                      const linkUrl = text.data?.uri || ''
                      if (linkText && linkUrl) {
                        itemParts.push(`[${linkText}](${linkUrl})`)
                      }
                    }
                  })
                }
              })
                      if (itemParts.length > 0) {
                        const prefix = isOrdered ? `${listCounter}. ` : '- '
                        let itemContent = itemParts.join(' ')
                        // Clean up spaces inside markers
                        itemContent = itemContent.replace(/\*\* +([^*]+?) +\*\*/g, '**$1**') // Bold
                        itemContent = itemContent.replace(/\* +([^*]+?) +\*/g, '*$1*') // Italic
                        itemContent = itemContent.replace(/\s+/g, ' ').trim()
                        markdownLines.push(`${prefix}${itemContent}`)
                        if (isOrdered) listCounter++
                      }
            }
          })
        }
        break

      case 'blockquote':
        const quoteText = []
        if (node.content) {
          node.content.forEach(para => {
            if (para.nodeType === 'paragraph' && para.content) {
              para.content.forEach(text => {
                        if (text.nodeType === 'text') {
                          let textValue = (text.value || '').trim()
                          if (!textValue) return
                          
                          // Handle marks in blockquotes
                          if (text.marks && text.marks.length > 0) {
                            const marks = text.marks || []
                            const sortedMarks = [...marks].sort((a, b) => {
                              const order = { 'bold': 1, 'italic': 2, 'code': 3 }
                              return (order[a.type] || 99) - (order[b.type] || 99)
                            })
                            
                            sortedMarks.forEach(mark => {
                              if (mark.type === 'bold') {
                                textValue = `**${textValue.trim()}**`
                              } else if (mark.type === 'italic') {
                                textValue = `*${textValue.trim()}*`
                              } else if (mark.type === 'code') {
                                textValue = `\`${textValue.trim()}\``
                              }
                            })
                          }
                          quoteText.push(textValue)
                } else if (text.nodeType === 'hyperlink') {
                  // Handle hyperlinks in blockquotes
                  const linkText = (text.content?.[0]?.value || '').trim()
                  const linkUrl = text.data?.uri || ''
                  if (linkText && linkUrl) {
                    quoteText.push(`[${linkText}](${linkUrl})`)
                  }
                }
              })
            }
          })
        }
                if (quoteText.length > 0) {
                  let quoteContent = quoteText.join(' ')
                  // Clean up spaces inside markers
                  quoteContent = quoteContent.replace(/\*\* +([^*]+?) +\*\*/g, '**$1**') // Bold
                  quoteContent = quoteContent.replace(/\* +([^*]+?) +\*/g, '*$1*') // Italic
                  quoteContent = quoteContent.replace(/\s+/g, ' ').trim()
                  markdownLines.push(`> ${quoteContent}`)
                }
        break

      case 'hyperlink':
        // Hyperlinks are handled within paragraph text nodes
        // If a standalone hyperlink block is encountered, convert to paragraph
        const linkText = node.content?.[0]?.value || ''
        const linkUrl = node.data?.uri || ''
        if (linkText && linkUrl) {
          markdownLines.push(`[${linkText}](${linkUrl})`)
        }
        break

      default:
        console.log(`     ⚠️  Unhandled node type: ${node.nodeType}`)
    }
  }

  processNode(contentfulRichText)
  return markdownLines.join('\n\n')
}

/**
 * Sleep utility for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Export all functions
module.exports = {
  contentfulClient,
  strapiRequest,
  authenticateAdmin,
  uploadMediaToStrapi,
  uploadMultipleMediaToStrapi,
  createStrapiEntry,
  updateStrapiEntry,
  getStrapiEntries,
  contentTypeExists,
  createStrapiContentType,
  mapText,
  mapRichText,
  mapNumber,
  mapDate,
  mapBoolean,
  mapLocation,
  mapReference,
  convertContentfulRichTextToStrapi,
  sleep,
}

// Export utility scripts
const deleteUnusedMedia = require('./delete-unused-media')
const createMagazinePost = require('./create-magazine-post')

module.exports.deleteUnusedMedia = deleteUnusedMedia
module.exports.createMagazinePost = createMagazinePost


