-- ================================================================
-- COMPANIES
-- A company is the top-level tenant. All data is scoped to a company.
-- Assumption: StockFlow is multi-tenant — each business is one company.
-- ================================================================
CREATE TABLE companies (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW(),
    is_active       BOOLEAN DEFAULT TRUE
);

-- ================================================================
-- WAREHOUSES
-- A company can have multiple warehouses in different locations.
-- ================================================================
CREATE TABLE warehouses (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    location        TEXT,                    -- Address or city
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT NOW(),

    INDEX idx_warehouses_company (company_id)
);

-- ================================================================
-- SUPPLIERS
-- A supplier is external — they supply products to companies.
-- Assumption: A supplier can work with multiple companies.
-- A supplier has one primary contact for reorder communication.
-- ================================================================
CREATE TABLE suppliers (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    contact_email   VARCHAR(255),
    contact_phone   VARCHAR(50),
    address         TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ================================================================
-- PRODUCTS
-- Core product catalog. A product belongs to a company.
-- Assumption: SKUs are unique per company, not globally across all 
-- companies on the platform. Two different companies could have the
-- same SKU for entirely different products.
-- ================================================================
CREATE TABLE products (
    id                  SERIAL PRIMARY KEY,
    company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    supplier_id         INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    name                VARCHAR(255) NOT NULL,
    sku                 VARCHAR(100) NOT NULL,
    description         TEXT,
    price               NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    product_type        VARCHAR(50) DEFAULT 'standard',
                        -- 'standard', 'bundle' — used to route bundle logic
    low_stock_threshold INTEGER DEFAULT 10 CHECK (low_stock_threshold >= 0),
                        -- Per product customizable threshold for alerts
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW(),

    UNIQUE (company_id, sku),  -- SKU unique within a company
    INDEX idx_products_company (company_id),
    INDEX idx_products_supplier (supplier_id)
);

-- ================================================================
-- BUNDLES
-- Products that are composed of other products.
-- Assumption: Bundles are one level deep — a bundle cannot contain
-- another bundle. This keeps inventory calculation simple and avoids
-- recursive resolution at query time.
-- ================================================================
CREATE TABLE bundle_items (
    id              SERIAL PRIMARY KEY,
    bundle_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    component_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),

    UNIQUE (bundle_id, component_id),
    INDEX idx_bundle_items_bundle (bundle_id)
);

-- ================================================================
-- INVENTORY
-- Tracks how much of each product is in each warehouse.
-- A product can appear in multiple warehouses — each gets its own row.
-- ================================================================
CREATE TABLE inventory (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    quantity        INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at      TIMESTAMP DEFAULT NOW(),

    UNIQUE (product_id, warehouse_id),  -- One row per product-warehouse pair
    INDEX idx_inventory_product (product_id),
    INDEX idx_inventory_warehouse (warehouse_id)
);

-- ================================================================
-- INVENTORY LEDGER (Audit Log)
-- Every change to inventory is recorded here for traceability.
-- Assumption: "Track when inventory levels change" means a full 
-- append-only audit trail, not just storing the last-updated timestamp.
-- This also powers sales activity detection for the low-stock alert.
-- ================================================================
CREATE TABLE inventory_ledger (
    id              SERIAL PRIMARY KEY,
    inventory_id    INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
    change_type     VARCHAR(50) NOT NULL,
                    -- 'sale', 'purchase', 'adjustment', 'transfer_in', 'transfer_out'
    quantity_delta  INTEGER NOT NULL,  -- Positive = stock added, Negative = stock removed
    quantity_after  INTEGER NOT NULL,  -- Snapshot of quantity after this change
    reference_id    INTEGER,           -- Optional: Order ID, PO number, etc.
    notes           TEXT,
    created_at      TIMESTAMP DEFAULT NOW(),

    INDEX idx_ledger_inventory (inventory_id),
    INDEX idx_ledger_product_warehouse (product_id, warehouse_id),
    INDEX idx_ledger_created_at (created_at),  -- For date-range queries in alerts
    INDEX idx_ledger_change_type (change_type)
);

-- ================================================================
-- COMPANY_SUPPLIERS (Junction Table)
-- Links which suppliers work with which companies.
-- Assumption: A supplier can serve multiple companies, and a company
-- can have multiple suppliers.
-- ================================================================
CREATE TABLE company_suppliers (
    company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    supplier_id     INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    is_preferred    BOOLEAN DEFAULT FALSE,  -- Company's preferred supplier for a product
    created_at      TIMESTAMP DEFAULT NOW(),

    PRIMARY KEY (company_id, supplier_id)
);
