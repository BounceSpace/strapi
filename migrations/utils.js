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
const FormData = require('form-data')
const fs = require('fs')
const https = require('https')
const http = require('http')
const path = require('path')

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
  if (options.body instanceof FormData) {
    delete defaultOptions.headers['Content-Type']
    defaultOptions.headers = {
      ...defaultOptions.headers,
      ...options.body.getHeaders(),
    }
  }

  const response = await fetch(url, defaultOptions)
  
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Strapi API error (${response.status}): ${errorText}`)
  }

  return response.json()
}

/**
 * Upload a media file to Strapi
 * @param {Object} asset - Contentful asset object
 * @param {string} fieldName - Field name in Strapi
 * @returns {Promise<number|null>} - Strapi file ID or null if failed
 */
async function uploadMediaToStrapi(asset, fieldName = 'file') {
  if (!asset || !asset.fields || !asset.fields.file) {
    console.log(`⚠️  No asset data for ${fieldName}, skipping...`)
    return null
  }

  try {
    const fileUrl = `https:${asset.fields.file.url}`
    const fileName = asset.fields.file.fileName
    const contentType = asset.fields.file.contentType

    console.log(`📤 Uploading ${fileName} (${fieldName})...`)

    // Download file to temporary location
      const tempDir = path.join(process.cwd(), '.temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const tempFilePath = path.join(tempDir, fileName)

    // Download file
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

    // Upload to Strapi
    const formData = new FormData()
    formData.append('files', fs.createReadStream(tempFilePath), {
      filename: fileName,
      contentType: contentType,
    })

    const response = await strapiRequest('/api/upload', {
      method: 'POST',
      body: formData,
      headers: {},
    })

    // Clean up temp file
    fs.unlinkSync(tempFilePath)

    if (response && response.length > 0) {
      console.log(`✅ Uploaded ${fileName} (ID: ${response[0].id})`)
      return response[0].id
    }

    return null
  } catch (error) {
    console.error(`❌ Error uploading media for ${fieldName}:`, error.message)
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
async function getStrapiEntries(contentType, filters = {}) {
  try {
    const queryParams = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      queryParams.append(key, value)
    })
    
    const query = queryParams.toString()
    const endpoint = `/api/${contentType}${query ? `?${query}` : ''}`
    
    const response = await strapiRequest(endpoint)
    return response.data || []
  } catch (error) {
    console.error(`❌ Error fetching ${contentType} entries:`, error.message)
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
  sleep,
}

