/**
 * Migration 10: Backfill monthlyPriceEuro on Location Options
 *
 * Iterates over all LocationOption entries and parses the euro price from
 * priceText when it contains "p.m." (per month), then writes that value to
 * the new monthlyPriceEuro field.
 *
 * Parsing rules:
 *   "€100 p.m."  → 100
 *   "€250 p.m."  → 250
 *   "€12,50 - €20,00" → skip (no "p.m.")
 *   "€15 p.d."   → skip (no "p.m.")
 */

const { getStrapiEntries, strapiRequest } = require('./utils')

/**
 * Parse the monthly euro price from a priceText string.
 * Returns null if the string does not represent a per-month price.
 */
function parseMonthlyPrice(priceText) {
  if (!priceText || !priceText.includes('p.m.')) return null

  // Match the first euro amount directly followed (possibly with whitespace) by p.m.
  // e.g. "€100 p.m." or "€12,50 p.m."
  const match = priceText.match(/€([\d.,]+)\s*p\.m\./)
  if (!match) return null

  // Normalise European decimal notation (comma → dot), strip thousand-sep dots
  const normalised = match[1].replace(/\.(?=\d{3})/g, '').replace(',', '.')
  const value = parseFloat(normalised)

  return isNaN(value) ? null : Math.round(value * 100) / 100
}

async function backfillMonthlyPrice() {
  console.log('\n🚀 Starting backfill: monthlyPriceEuro on Location Options\n')

  let successCount = 0
  let skippedCount = 0
  let errorCount = 0

  try {
    console.log('📥 Fetching all Location Option entries from Strapi...')
    const entries = await getStrapiEntries('locationoption', { pagination: { pageSize: 200 } })
    console.log(`Found ${entries.length} entries\n`)

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const id = entry.documentId || entry.id
      const priceText = entry.priceText || ''
      const title = entry.title || `(id: ${id})`

      const price = parseMonthlyPrice(priceText)

      if (price === null) {
        console.log(`[${i + 1}/${entries.length}] ⏭️  Skipping "${title}" — priceText: "${priceText}"`)
        skippedCount++
        continue
      }

      console.log(`[${i + 1}/${entries.length}] 💶 "${title}" — "${priceText}" → ${price}`)

      try {
        // Try Content Manager API first (handles draft/publish state correctly)
        try {
          await strapiRequest(
            `/api/content-manager/collection-types/api::locationoption.locationoption/${id}`,
            {
              method: 'PUT',
              body: JSON.stringify({ monthlyPriceEuro: price }),
            }
          )
        } catch {
          // Fall back to REST API
          await strapiRequest(`/api/locationoptions/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { monthlyPriceEuro: price } }),
          })
        }

        console.log(`   ✅ Updated`)
        successCount++
      } catch (err) {
        console.error(`   ❌ Failed to update: ${err.message}`)
        errorCount++
      }
    }

    console.log('\n📊 Backfill complete!')
    console.log(`   Updated : ${successCount}`)
    console.log(`   Skipped : ${skippedCount}`)
    console.log(`   Errors  : ${errorCount}`)

    return { success: errorCount === 0, successCount, skippedCount, errorCount }
  } catch (err) {
    console.error('\n❌ Fatal error:', err)
    throw err
  }
}

if (require.main === module) {
  backfillMonthlyPrice()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch(() => process.exit(1))
}

module.exports = backfillMonthlyPrice
