// low_stock_alerts.js
// Route: GET /api/companies/:company_id/alerts/low-stock
//
// This endpoint returns all products for a company that are:
//   1. Currently below their low-stock threshold
//   2. Have had at least one sale in the last 30 days (active products only)
//   3. Enriched with supplier contact info for easy reordering

const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

// ---------------------------------------------------------------
// Database connection pool
// Assumption: Connection config comes from environment variables.
// Never hardcode credentials — even in internal tools.
// ---------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,           // Max concurrent connections
  idleTimeoutMillis: 30000,
});

// ---------------------------------------------------------------
// Constants
// Centralizing these makes them easy to change without hunting
// through business logic later.
// ---------------------------------------------------------------
const RECENT_SALES_WINDOW_DAYS = 30;

// ---------------------------------------------------------------
// Helper: Validate that company_id is a positive integer
// Reason: Prevents SQL injection at the parameter level and gives 
// a clear error before any DB call is made.
// ---------------------------------------------------------------
function isValidId(id) {
  const num = parseInt(id, 10);
  return !isNaN(num) && num > 0 && String(num) === String(id);
}

// ---------------------------------------------------------------
// Helper: Calculate days until stockout
// Formula: current_stock / avg_daily_sales
// If avg_daily_sales is 0 (no recent sales), we return null —
// we can't predict stockout for products with no sales velocity.
// Returning null is better than returning Infinity or a huge number
// that would confuse business users.
// ---------------------------------------------------------------
function calcDaysUntilStockout(currentStock, totalSalesLast30Days) {
  if (!totalSalesLast30Days || totalSalesLast30Days <= 0) return null;
  const avgDailySales = totalSalesLast30Days / RECENT_SALES_WINDOW_DAYS;
  if (avgDailySales === 0) return null;
  return Math.floor(currentStock / avgDailySales);
}

// ---------------------------------------------------------------
// Main Route Handler
// ---------------------------------------------------------------
router.get('/companies/:company_id/alerts/low-stock', async (req, res) => {

  const { company_id } = req.params;

  // -----------------------------------------------------------
  // Step 1: Validate company_id format
  // Reason: We want to reject garbage input before any DB call.
  // -----------------------------------------------------------
  if (!isValidId(company_id)) {
    return res.status(400).json({
      error: 'Invalid company_id. Must be a positive integer.'
    });
  }

  const client = await pool.connect();

  try {
    // ---------------------------------------------------------
    // Step 2: Verify the company exists
    // Reason: Fail fast with a clear 404 rather than returning
    // an empty alerts array that looks like "no alerts found"
    // when the company doesn't exist at all.
    // ---------------------------------------------------------
    const companyCheck = await client.query(
      `SELECT id, name FROM companies WHERE id = $1 AND is_active = TRUE`,
      [company_id]
    );

    if (companyCheck.rows.length === 0) {
      return res.status(404).json({
        error: `Company with id ${company_id} not found.`
      });
    }

    // ---------------------------------------------------------
    // Step 3: Main query — fetch low-stock alerts
    //
    // This query does several things in one shot:
    //
    // a) Joins products → inventory → warehouses to get per-warehouse stock
    // b) Joins suppliers for reorder contact info
    // c) Subquery: SUM of units sold in last 30 days per product-warehouse
    //    (only counting ledger entries with change_type = 'sale')
    // d) Filters: 
    //    - Only products in this company
    //    - Only active products and warehouses
    //    - Only where current_stock <= low_stock_threshold
    //    - Only where there was at least 1 sale in the last 30 days
    //      (HAVING clause on the subquery)
    //
    // Assumption: We look at each warehouse independently.
    // A product might be low in Warehouse A but fine in Warehouse B —
    // both generate separate alerts so the user knows which warehouse
    // to restock, not just which product.
    // ---------------------------------------------------------
    const alertsQuery = `
      SELECT
        p.id                    AS product_id,
        p.name                  AS product_name,
        p.sku                   AS sku,
        p.low_stock_threshold   AS threshold,
        w.id                    AS warehouse_id,
        w.name                  AS warehouse_name,
        i.quantity              AS current_stock,
        s.id                    AS supplier_id,
        s.name                  AS supplier_name,
        s.contact_email         AS supplier_email,
        COALESCE(recent.total_sold, 0) AS total_sold_last_30_days
      FROM products p
      JOIN inventory i
        ON i.product_id = p.id
      JOIN warehouses w
        ON w.id = i.warehouse_id
        AND w.company_id = $1
        AND w.is_active = TRUE
      LEFT JOIN suppliers s
        ON s.id = p.supplier_id
      -- Subquery: total units sold per product-warehouse in last 30 days
      -- LEFT JOIN so products with NO recent sales are still returned
      -- (we filter them out with the HAVING/WHERE below)
      LEFT JOIN (
        SELECT
          il.product_id,
          il.warehouse_id,
          SUM(ABS(il.quantity_delta)) AS total_sold
        FROM inventory_ledger il
        WHERE
          il.change_type = 'sale'
          AND il.created_at >= NOW() - INTERVAL '${RECENT_SALES_WINDOW_DAYS} days'
        GROUP BY il.product_id, il.warehouse_id
      ) recent
        ON recent.product_id = p.id
        AND recent.warehouse_id = w.id
      WHERE
        p.company_id = $1
        AND p.is_active = TRUE
        AND p.product_type != 'bundle'
        -- Only alert if current stock is at or below threshold
        AND i.quantity <= p.low_stock_threshold
        -- Only alert if there have been sales in the last 30 days
        -- Products with no recent sales are likely discontinued or seasonal
        AND COALESCE(recent.total_sold, 0) > 0
      ORDER BY
        -- Most urgent (fewest days of stock) shown first
        -- Products with no calculable stockout date go to the bottom
        CASE WHEN recent.total_sold > 0 
             THEN (i.quantity::float / (recent.total_sold::float / ${RECENT_SALES_WINDOW_DAYS}))
             ELSE 99999 
        END ASC
    `;

    // ---------------------------------------------------------
    // Assumption on bundles: We exclude bundles from alerts.
    // Bundle stock is a derived concept (min of component stock) —
    // alerting on bundles directly would be misleading. The 
    // component products will generate their own alerts.
    // ---------------------------------------------------------

    const result = await client.query(alertsQuery, [company_id]);

    // ---------------------------------------------------------
    // Step 4: Format the response
    // We do the days_until_stockout calculation in JS rather than
    // SQL because the helper function has cleaner edge case handling
    // (null for undefined, floor for partial days).
    // ---------------------------------------------------------
    const alerts = result.rows.map(row => ({
      product_id: row.product_id,
      product_name: row.product_name,
      sku: row.sku,
      warehouse_id: row.warehouse_id,
      warehouse_name: row.warehouse_name,
      current_stock: parseInt(row.current_stock),
      threshold: parseInt(row.threshold),
      days_until_stockout: calcDaysUntilStockout(
        parseInt(row.current_stock),
        parseInt(row.total_sold_last_30_days)
      ),
      supplier: row.supplier_id
        ? {
            id: row.supplier_id,
            name: row.supplier_name,
            contact_email: row.supplier_email,
          }
        : null,
      // null supplier means the product has no linked supplier — 
      // the frontend should flag this as "no reorder contact available"
    }));

    // ---------------------------------------------------------
    // Step 5: Return response
    // ---------------------------------------------------------
    return res.status(200).json({
      alerts,
      total_alerts: alerts.length,
    });

  } catch (err) {
    // ---------------------------------------------------------
    // Error handling: Log the full error server-side but return
    // a generic message to the client.
    // Never expose raw DB errors to API consumers — they can 
    // reveal table names, column names, and query structure.
    // ---------------------------------------------------------
    console.error(`[low-stock-alerts] company_id=${company_id} error:`, err);
    return res.status(500).json({
      error: 'An internal error occurred while fetching low-stock alerts. Please try again.'
    });

  } finally {
    // ---------------------------------------------------------
    // Always release the client back to the pool.
    // If we don't, the pool exhausts connections and the whole
    // service becomes unresponsive under load.
    // ---------------------------------------------------------
    client.release();
  }
});

module.exports = router;
