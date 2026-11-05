import type { Migration } from '../../core/migrate.js';

export const catalogMigrations: Migration[] = [
  {
    version: '001',
    name: 'products, prices, features, meters, coupons, entitlements',
    up: `
      CREATE TABLE meters (
        id text PRIMARY KEY,
        key text NOT NULL UNIQUE,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        unit text NOT NULL DEFAULT 'units',
        kind text NOT NULL DEFAULT 'counter' CHECK (kind IN ('counter', 'gauge')),
        weights jsonb NOT NULL DEFAULT '{}',
        credit_type text,
        credits_per_unit numeric(20, 6),
        archived boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE features (
        id text PRIMARY KEY,
        key text NOT NULL UNIQUE,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        type text NOT NULL CHECK (type IN ('boolean', 'quota', 'config')),
        meter_key text REFERENCES meters(key) ON UPDATE CASCADE,
        unit text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CHECK (type <> 'quota' OR meter_key IS NOT NULL)
      );
      CREATE UNIQUE INDEX features_meter_uq ON features (meter_key) WHERE meter_key IS NOT NULL;

      CREATE TABLE products (
        id text PRIMARY KEY,
        key text NOT NULL UNIQUE,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        kind text NOT NULL CHECK (kind IN ('plan', 'addon', 'one_time', 'credit_pack')),
        plan_type text CHECK (plan_type IN ('free', 'paid', 'lifetime', 'custom')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
        is_public boolean NOT NULL DEFAULT true,
        subscriber_type text NOT NULL DEFAULT 'user' CHECK (subscriber_type IN ('user', 'organization')),
        sort_order int NOT NULL DEFAULT 0,
        trial_days int NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
        trial_requires_payment_method boolean NOT NULL DEFAULT false,
        grace_days int NOT NULL DEFAULT 3 CHECK (grace_days >= 0),
        credit_type text,
        credit_amount bigint,
        credits_expire_days int,
        highlights jsonb NOT NULL DEFAULT '[]',
        metadata jsonb NOT NULL DEFAULT '{}',
        gateway_refs jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE prices (
        id text PRIMARY KEY,
        product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        nickname text,
        currency text NOT NULL,
        type text NOT NULL CHECK (type IN ('recurring', 'one_time')),
        interval text CHECK (interval IN ('day', 'week', 'month', 'year')),
        interval_count int NOT NULL DEFAULT 1 CHECK (interval_count > 0),
        pricing_model text NOT NULL DEFAULT 'flat' CHECK (pricing_model IN ('flat', 'per_seat', 'usage', 'tiered')),
        unit_amount bigint NOT NULL DEFAULT 0 CHECK (unit_amount >= 0),
        meter_key text REFERENCES meters(key) ON UPDATE CASCADE,
        included_units bigint NOT NULL DEFAULT 0,
        tiers jsonb,
        tier_mode text CHECK (tier_mode IN ('graduated', 'volume')),
        package_size int CHECK (package_size > 0),
        tax_behavior text NOT NULL DEFAULT 'exclusive' CHECK (tax_behavior IN ('inclusive', 'exclusive')),
        intro_amount bigint CHECK (intro_amount >= 0),
        intro_cycles int CHECK (intro_cycles > 0),
        min_quantity int NOT NULL DEFAULT 1,
        max_quantity int,
        active boolean NOT NULL DEFAULT true,
        gateway_refs jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        CHECK ((type = 'recurring') = (interval IS NOT NULL)),
        CHECK (pricing_model NOT IN ('usage', 'tiered') OR meter_key IS NOT NULL OR pricing_model = 'tiered')
      );
      CREATE INDEX prices_product_idx ON prices (product_id);

      CREATE TABLE product_features (
        product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        feature_id text NOT NULL REFERENCES features(id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT true,
        limit_value bigint CHECK (limit_value >= 0),
        unlimited boolean NOT NULL DEFAULT false,
        reset_period text NOT NULL DEFAULT 'month' CHECK (reset_period IN ('none', 'day', 'week', 'month', 'year', 'billing_period', 'rolling')),
        rolling_window_seconds int CHECK (rolling_window_seconds > 0),
        enforcement text NOT NULL DEFAULT 'hard' CHECK (enforcement IN ('hard', 'soft', 'overage')),
        warn_at_percent int NOT NULL DEFAULT 80 CHECK (warn_at_percent BETWEEN 1 AND 100),
        grace_units bigint NOT NULL DEFAULT 0 CHECK (grace_units >= 0),
        overage_unit_amount bigint,
        per_seat boolean NOT NULL DEFAULT false,
        config_value jsonb,
        PRIMARY KEY (product_id, feature_id)
      );

      CREATE TABLE coupons (
        id text PRIMARY KEY,
        code text NOT NULL,
        name text NOT NULL,
        discount_type text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
        percent_off_bps int CHECK (percent_off_bps BETWEEN 1 AND 10000),
        amount_off bigint CHECK (amount_off > 0),
        currency text,
        duration text NOT NULL DEFAULT 'once' CHECK (duration IN ('once', 'repeating', 'forever')),
        duration_cycles int CHECK (duration_cycles > 0),
        max_redemptions int CHECK (max_redemptions > 0),
        redeemed_count int NOT NULL DEFAULT 0,
        max_per_customer int NOT NULL DEFAULT 1,
        applies_to jsonb NOT NULL DEFAULT '[]',
        first_purchase_only boolean NOT NULL DEFAULT false,
        min_amount bigint,
        starts_at timestamptz,
        expires_at timestamptz,
        active boolean NOT NULL DEFAULT true,
        campaign text,
        affiliate_id text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CHECK ((discount_type = 'percent' AND percent_off_bps IS NOT NULL) OR (discount_type = 'fixed' AND amount_off IS NOT NULL AND currency IS NOT NULL)),
        CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
      );
      CREATE UNIQUE INDEX coupons_code_uq ON coupons (lower(code));

      CREATE TABLE coupon_redemptions (
        id text PRIMARY KEY,
        coupon_id text NOT NULL REFERENCES coupons(id),
        user_id text,
        org_id text,
        order_id text,
        subscription_id text,
        discount_amount bigint,
        currency text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (coupon_id, created_at DESC);
      CREATE INDEX coupon_redemptions_user_idx ON coupon_redemptions (user_id);

      CREATE TABLE entitlement_grants (
        id text PRIMARY KEY,
        subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
        subject_id text NOT NULL,
        product_id text NOT NULL REFERENCES products(id),
        quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
        source text NOT NULL CHECK (source IN ('purchase', 'admin', 'promotion', 'bundle', 'migration')),
        source_ref text,
        reason text,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz,
        revoked_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX entitlement_grants_subject_idx ON entitlement_grants (subject_type, subject_id);

      CREATE TABLE entitlement_overrides (
        id text PRIMARY KEY,
        subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
        subject_id text NOT NULL,
        feature_id text NOT NULL REFERENCES features(id) ON DELETE CASCADE,
        mode text NOT NULL DEFAULT 'set' CHECK (mode IN ('set', 'add')),
        enabled boolean,
        limit_value bigint,
        unlimited boolean,
        enforcement text CHECK (enforcement IN ('hard', 'soft', 'overage')),
        config_value jsonb,
        reason text NOT NULL,
        starts_at timestamptz NOT NULL,
        expires_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX entitlement_overrides_subject_idx ON entitlement_overrides (subject_type, subject_id);
    `,
  },
  {
    version: '002',
    name: 'catalog: installments, fixed-term access, purchase rules, stock, bundles, coupon batches',
    up: `
      -- A recurring price can be paid in a fixed number of installments; a one-time price can grant access for N days.
      ALTER TABLE prices ADD COLUMN payment_count int CHECK (payment_count > 0);
      ALTER TABLE prices ADD COLUMN after_last_payment text NOT NULL DEFAULT 'end_access' CHECK (after_last_payment IN ('end_access', 'keep_access'));
      ALTER TABLE prices ADD COLUMN access_days int CHECK (access_days > 0);
      ALTER TABLE prices ADD COLUMN stock_limit int CHECK (stock_limit >= 0);
      ALTER TABLE prices ADD CONSTRAINT prices_payment_count_recurring CHECK (payment_count IS NULL OR type = 'recurring');
      ALTER TABLE prices ADD CONSTRAINT prices_access_days_one_time CHECK (access_days IS NULL OR type = 'one_time');

      -- Who may buy a product, and how many can be sold.
      ALTER TABLE products ADD COLUMN requires_products jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE products ADD COLUMN excludes_products jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE products ADD COLUMN purchase_limit int CHECK (purchase_limit > 0);
      ALTER TABLE products ADD COLUMN stock_limit int CHECK (stock_limit >= 0);

      -- Units of each sale: reserved when the sale starts, sold when it is paid, released when it expires or is voided.
      CREATE TABLE stock_reservations (
        id text PRIMARY KEY,
        product_id text NOT NULL REFERENCES products(id),
        price_id text REFERENCES prices(id),
        subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
        subject_id text NOT NULL,
        user_id text,
        org_id text,
        quantity int NOT NULL CHECK (quantity > 0),
        source_type text NOT NULL CHECK (source_type IN ('checkout', 'order', 'subscription')),
        source_id text NOT NULL,
        order_id text,
        status text NOT NULL CHECK (status IN ('reserved', 'sold', 'released')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX stock_reservations_product_idx ON stock_reservations (product_id, status);
      CREATE INDEX stock_reservations_price_idx ON stock_reservations (price_id, status) WHERE price_id IS NOT NULL;
      CREATE INDEX stock_reservations_source_idx ON stock_reservations (source_type, source_id);
      CREATE INDEX stock_reservations_subject_idx ON stock_reservations (subject_type, subject_id, product_id);
      CREATE INDEX stock_reservations_order_idx ON stock_reservations (order_id) WHERE order_id IS NOT NULL;

      -- Owning a bundle confers the products it includes.
      CREATE TABLE product_bundle_items (
        bundle_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (bundle_id, product_id),
        CHECK (bundle_id <> product_id)
      );
      CREATE INDEX product_bundle_items_product_idx ON product_bundle_items (product_id);

      -- Single-use codes generated from one set of coupon terms.
      CREATE TABLE coupon_batches (
        id text PRIMARY KEY,
        name text NOT NULL,
        prefix text NOT NULL DEFAULT '',
        count int NOT NULL CHECK (count > 0),
        campaign text,
        created_by text,
        created_at timestamptz NOT NULL
      );
      ALTER TABLE coupons ADD COLUMN batch_id text REFERENCES coupon_batches(id);
      CREATE INDEX coupons_batch_idx ON coupons (batch_id) WHERE batch_id IS NOT NULL;
    `,
  },
];
