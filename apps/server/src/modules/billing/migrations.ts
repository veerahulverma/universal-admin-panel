import type { Migration } from '../../core/migrate.js';

export const billingMigrations: Migration[] = [
  {
    version: '001',
    name: 'billing: gateways, subscriptions, invoices, payments',
    up: `
      CREATE TABLE payment_gateways (
        id text PRIMARY KEY,
        adapter text NOT NULL,
        name text NOT NULL,
        mode text NOT NULL CHECK (mode IN ('test', 'live')),
        enabled boolean NOT NULL DEFAULT true,
        is_default boolean NOT NULL DEFAULT false,
        priority int NOT NULL DEFAULT 0,
        config jsonb NOT NULL DEFAULT '{}',
        currencies jsonb,
        last_test_at timestamptz,
        last_test_ok boolean,
        last_test_message text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE billing_profiles (
        id text PRIMARY KEY,
        subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
        subject_id text NOT NULL,
        name text,
        company text,
        email text,
        address jsonb NOT NULL DEFAULT '{}',
        country text,
        region text,
        tax_id text,
        tax_id_type text,
        tax_exempt boolean NOT NULL DEFAULT false,
        preferred_currency text,
        gateway_customers jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (subject_type, subject_id)
      );

      CREATE TABLE payment_methods (
        id text PRIMARY KEY,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        gateway_id text NOT NULL REFERENCES payment_gateways(id),
        gateway_ref text NOT NULL,
        customer_ref text,
        type text NOT NULL,
        brand text,
        last4 text,
        exp_month int,
        exp_year int,
        is_default boolean NOT NULL DEFAULT false,
        detached_at timestamptz,
        created_at timestamptz NOT NULL,
        UNIQUE (gateway_id, gateway_ref)
      );
      CREATE INDEX payment_methods_subject_idx ON payment_methods (subject_type, subject_id);

      CREATE TABLE tax_rates (
        id text PRIMARY KEY,
        name text NOT NULL,
        country text NOT NULL,
        region text,
        rate_bps int NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
        tax_type text NOT NULL DEFAULT 'vat' CHECK (tax_type IN ('vat', 'gst', 'sales_tax', 'other')),
        reverse_charge_b2b boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX tax_rates_country_idx ON tax_rates (country, region) WHERE active;

      CREATE TABLE subscriptions (
        id text PRIMARY KEY,
        subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization')),
        subject_id text NOT NULL,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        org_id text REFERENCES organizations(id) ON DELETE CASCADE,
        product_id text NOT NULL REFERENCES products(id),
        price_id text NOT NULL REFERENCES prices(id),
        status text NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'unpaid')),
        quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
        currency text NOT NULL,
        collection_method text NOT NULL DEFAULT 'charge_automatically' CHECK (collection_method IN ('charge_automatically', 'send_invoice', 'complimentary')),
        gateway_id text REFERENCES payment_gateways(id),
        payment_method_id text REFERENCES payment_methods(id),
        current_period_start timestamptz NOT NULL,
        current_period_end timestamptz NOT NULL,
        trial_start timestamptz,
        trial_end timestamptz,
        cancel_at_period_end boolean NOT NULL DEFAULT false,
        canceled_at timestamptz,
        cancel_reason text,
        ended_at timestamptz,
        paused_at timestamptz,
        resume_at timestamptz,
        grace_until timestamptz,
        coupon_id text REFERENCES coupons(id),
        discount_cycles_remaining int,
        intro_cycles_remaining int,
        scheduled_change jsonb,
        next_payment_attempt_at timestamptz,
        payment_attempts int NOT NULL DEFAULT 0,
        checkout_id text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX subscriptions_subject_idx ON subscriptions (subject_type, subject_id);
      CREATE INDEX subscriptions_renewal_idx ON subscriptions (current_period_end) WHERE status IN ('active', 'trialing', 'past_due');
      CREATE INDEX subscriptions_status_idx ON subscriptions (status, created_at DESC);
      CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);

      CREATE TABLE checkout_sessions (
        id text PRIMARY KEY,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        user_id text,
        org_id text,
        kind text NOT NULL CHECK (kind IN ('purchase', 'invoice')),
        status text NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'canceled', 'failed')),
        price_id text,
        product_id text,
        quantity int NOT NULL DEFAULT 1,
        coupon_id text,
        invoice_id text,
        order_id text,
        subtotal bigint NOT NULL DEFAULT 0,
        discount bigint NOT NULL DEFAULT 0,
        tax bigint NOT NULL DEFAULT 0,
        total bigint NOT NULL DEFAULT 0,
        currency text NOT NULL,
        trial_days int NOT NULL DEFAULT 0,
        gateway_id text,
        gateway_session_id text,
        url text,
        success_url text,
        cancel_url text,
        failure_message text,
        expires_at timestamptz NOT NULL,
        completed_at timestamptz,
        recovery_email_sent_at timestamptz,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL
      );
      CREATE INDEX checkout_sessions_status_idx ON checkout_sessions (status, created_at DESC);
      CREATE INDEX checkout_sessions_subject_idx ON checkout_sessions (subject_type, subject_id);

      CREATE TABLE orders (
        id text PRIMARY KEY,
        number text UNIQUE,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        user_id text,
        org_id text,
        type text NOT NULL CHECK (type IN ('subscription', 'one_time', 'manual')),
        status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'canceled', 'refunded', 'partially_refunded')),
        currency text NOT NULL,
        subtotal bigint NOT NULL,
        discount_total bigint NOT NULL DEFAULT 0,
        tax_total bigint NOT NULL DEFAULT 0,
        total bigint NOT NULL,
        coupon_id text,
        checkout_id text,
        invoice_id text,
        subscription_id text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        paid_at timestamptz
      );
      CREATE INDEX orders_subject_idx ON orders (subject_type, subject_id);
      CREATE INDEX orders_created_idx ON orders (created_at DESC);

      CREATE TABLE order_items (
        id text PRIMARY KEY,
        order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id text,
        price_id text,
        description text NOT NULL,
        quantity int NOT NULL,
        unit_amount bigint NOT NULL,
        amount bigint NOT NULL,
        discount_amount bigint NOT NULL DEFAULT 0,
        tax_amount bigint NOT NULL DEFAULT 0
      );

      CREATE TABLE document_sequences (
        prefix text NOT NULL,
        year int NOT NULL,
        last_number int NOT NULL,
        PRIMARY KEY (prefix, year)
      );

      CREATE TABLE invoices (
        id text PRIMARY KEY,
        number text UNIQUE,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        user_id text,
        org_id text,
        subscription_id text,
        order_id text,
        status text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
        billing_reason text NOT NULL CHECK (billing_reason IN ('checkout', 'subscription_cycle', 'subscription_update', 'manual')),
        currency text NOT NULL,
        subtotal bigint NOT NULL DEFAULT 0,
        discount_total bigint NOT NULL DEFAULT 0,
        tax_total bigint NOT NULL DEFAULT 0,
        total bigint NOT NULL DEFAULT 0,
        balance_applied bigint NOT NULL DEFAULT 0,
        amount_due bigint NOT NULL DEFAULT 0,
        amount_paid bigint NOT NULL DEFAULT 0,
        amount_refunded bigint NOT NULL DEFAULT 0,
        period_start timestamptz,
        period_end timestamptz,
        due_at timestamptz,
        issued_at timestamptz,
        paid_at timestamptz,
        voided_at timestamptz,
        customer_details jsonb NOT NULL DEFAULT '{}',
        seller_details jsonb NOT NULL DEFAULT '{}',
        tax_note text,
        notes text,
        attempt_count int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX invoices_subject_idx ON invoices (subject_type, subject_id, created_at DESC);
      CREATE INDEX invoices_status_idx ON invoices (status, due_at);
      CREATE INDEX invoices_subscription_idx ON invoices (subscription_id);

      CREATE TABLE invoice_lines (
        id text PRIMARY KEY,
        invoice_id text NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        type text NOT NULL CHECK (type IN ('subscription', 'one_time', 'usage', 'overage', 'proration', 'manual')),
        description text NOT NULL,
        product_id text,
        price_id text,
        quantity bigint NOT NULL DEFAULT 1,
        unit_amount bigint NOT NULL,
        amount bigint NOT NULL,
        discount_amount bigint NOT NULL DEFAULT 0,
        tax_rate_bps int NOT NULL DEFAULT 0,
        tax_amount bigint NOT NULL DEFAULT 0,
        tax_inclusive boolean NOT NULL DEFAULT false,
        period_start timestamptz,
        period_end timestamptz,
        position int NOT NULL DEFAULT 0
      );
      CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id, position);

      CREATE TABLE payments (
        id text PRIMARY KEY,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        user_id text,
        org_id text,
        invoice_id text REFERENCES invoices(id),
        order_id text,
        gateway_id text REFERENCES payment_gateways(id),
        gateway_payment_id text,
        amount bigint NOT NULL,
        currency text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'disputed')),
        method_type text,
        method_details jsonb NOT NULL DEFAULT '{}',
        amount_refunded bigint NOT NULL DEFAULT 0,
        fee_amount bigint,
        failure_code text,
        failure_message text,
        manual_reference text,
        recorded_by text,
        created_at timestamptz NOT NULL,
        succeeded_at timestamptz,
        UNIQUE (gateway_id, gateway_payment_id)
      );
      CREATE INDEX payments_subject_idx ON payments (subject_type, subject_id, created_at DESC);
      CREATE INDEX payments_created_idx ON payments (created_at DESC);
      CREATE INDEX payments_status_idx ON payments (status, created_at DESC);

      CREATE TABLE credit_notes (
        id text PRIMARY KEY,
        number text NOT NULL UNIQUE,
        invoice_id text REFERENCES invoices(id),
        refund_id text,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        amount bigint NOT NULL,
        currency text NOT NULL,
        reason text,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE refunds (
        id text PRIMARY KEY,
        payment_id text NOT NULL REFERENCES payments(id),
        amount bigint NOT NULL CHECK (amount > 0),
        currency text NOT NULL,
        reason text,
        status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
        gateway_refund_id text,
        failure_message text,
        requested_by text,
        approval_id text,
        credit_note_id text,
        revoke_access boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        processed_at timestamptz
      );
      CREATE UNIQUE INDEX refunds_gateway_uq ON refunds (payment_id, gateway_refund_id) WHERE gateway_refund_id IS NOT NULL;

      CREATE TABLE disputes (
        id text PRIMARY KEY,
        payment_id text REFERENCES payments(id),
        gateway_id text NOT NULL,
        gateway_dispute_id text NOT NULL,
        amount bigint NOT NULL,
        currency text NOT NULL,
        reason text,
        status text NOT NULL CHECK (status IN ('needs_response', 'won', 'lost')),
        evidence_due_by timestamptz,
        created_at timestamptz NOT NULL,
        closed_at timestamptz,
        UNIQUE (gateway_id, gateway_dispute_id)
      );

      CREATE TABLE customer_balances (
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        currency text NOT NULL,
        balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (subject_type, subject_id, currency)
      );

      CREATE TABLE customer_balance_transactions (
        id text PRIMARY KEY,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        currency text NOT NULL,
        amount bigint NOT NULL,
        balance_after bigint NOT NULL,
        reason text NOT NULL,
        invoice_id text,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE gateway_events (
        id text PRIMARY KEY,
        gateway_id text NOT NULL,
        event_id text NOT NULL,
        type text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
        error text,
        attempts int NOT NULL DEFAULT 0,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        UNIQUE (gateway_id, event_id)
      );
      CREATE INDEX gateway_events_received_idx ON gateway_events (received_at DESC);

      CREATE TABLE exchange_rates (
        base text NOT NULL,
        quote text NOT NULL,
        rate numeric(24, 12) NOT NULL CHECK (rate > 0),
        source text NOT NULL DEFAULT 'manual',
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (base, quote)
      );
    `,
  },
  {
    version: '002',
    name: 'billing: fixed discount on subscription renewals',
    up: `ALTER TABLE subscriptions ADD COLUMN renewal_discount bigint NOT NULL DEFAULT 0 CHECK (renewal_discount >= 0);`,
  },
  {
    version: '003',
    name: 'billing: installments, gift vouchers, card expiry warnings, stock of past sales',
    up: `
      -- Periods billed and paid; a price with a payment count stops renewing after its last installment.
      ALTER TABLE subscriptions ADD COLUMN installments_billed int NOT NULL DEFAULT 0 CHECK (installments_billed >= 0);
      ALTER TABLE subscriptions ADD COLUMN installments_paid int NOT NULL DEFAULT 0 CHECK (installments_paid >= 0);

      -- The card expiry ('YYYY-MM') the customer was last warned about.
      ALTER TABLE payment_methods ADD COLUMN expiry_warned_for text;
      ALTER TABLE payment_methods ADD COLUMN expiry_warned_at timestamptz;

      CREATE TABLE voucher_batches (
        id text PRIMARY KEY,
        name text NOT NULL,
        prefix text NOT NULL DEFAULT '',
        count int NOT NULL CHECK (count > 0),
        created_by text,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE vouchers (
        id text PRIMARY KEY,
        code text NOT NULL,
        -- Uppercase letters and digits only, so codes match however they are typed.
        code_key text NOT NULL UNIQUE,
        batch_id text REFERENCES voucher_batches(id),
        name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('product', 'credit')),
        product_id text REFERENCES products(id),
        quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
        access_days int CHECK (access_days > 0),
        credit_amount bigint CHECK (credit_amount > 0),
        currency text,
        expires_at timestamptz,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'disabled')),
        redeemed_at timestamptz,
        subject_type text CHECK (subject_type IN ('user', 'organization')),
        subject_id text,
        user_id text,
        org_id text,
        grant_id text,
        created_by text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CHECK ((kind = 'product' AND product_id IS NOT NULL AND credit_amount IS NULL AND currency IS NULL)
            OR (kind = 'credit' AND credit_amount IS NOT NULL AND currency IS NOT NULL AND product_id IS NULL AND access_days IS NULL)),
        CHECK ((status = 'redeemed') = (redeemed_at IS NOT NULL))
      );
      CREATE INDEX vouchers_created_idx ON vouchers (created_at DESC);
      CREATE INDEX vouchers_batch_idx ON vouchers (batch_id) WHERE batch_id IS NOT NULL;
      CREATE INDEX vouchers_subject_idx ON vouchers (subject_type, subject_id) WHERE subject_id IS NOT NULL;

      -- Orders placed before stock was tracked still count against stock and per-customer limits.
      INSERT INTO stock_reservations (id, product_id, price_id, subject_type, subject_id, user_id, org_id, quantity, source_type, source_id, order_id, status, created_at, updated_at)
      SELECT 'stk_' || oi.id, oi.product_id, oi.price_id, o.subject_type, o.subject_id, o.user_id, o.org_id,
             CASE WHEN pr.type = 'one_time' THEN oi.quantity ELSE 1 END, 'order', o.id, o.id,
             CASE WHEN o.status = 'pending' THEN 'reserved' ELSE 'sold' END, o.created_at, o.created_at
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN prices pr ON pr.id = oi.price_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.status IN ('pending', 'paid', 'partially_refunded') AND oi.quantity > 0 AND o.subject_type IN ('user', 'organization');
    `,
  },
];
