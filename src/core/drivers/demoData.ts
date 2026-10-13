// Deterministic demo datasets for demo connections. Table names are unique across the databases of a
// dataset so unqualified names work in the SQL editor (SQLite resolves them across attached schemas).
import type { DemoDataset } from '../../shared/model';

export interface DemoTable {
  name: string;
  ddl: string;
  rows: () => unknown[][];
}

export interface DemoDatabase {
  name: string;
  tables: DemoTable[];
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ava', 'Liam', 'Noa', 'Ethan', 'Maya', 'Omar', 'Yael', 'Lucas', 'Sofia', 'Daniel', 'Mila', 'Ari', 'Lea', 'Kai', 'Zoe', 'Ido', 'Nina', 'Theo', 'Iris', 'Leo'];
const LAST = ['Cohen', 'Levi', 'Smith', 'Garcia', 'Kim', 'Novak', 'Rossi', 'Muller', 'Dubois', 'Silva', 'Haddad', 'Tanaka', 'Berg', 'Klein', 'Ortiz'];
const COUNTRIES = ['US', 'IL', 'DE', 'FR', 'GB', 'JP', 'BR', 'IN', 'CA', 'ES'];
const WORDS = ['Nebula', 'Quartz', 'Aurora', 'Pixel', 'Orbit', 'Coral', 'Echo', 'Drift', 'Lumen', 'Vertex', 'Comet', 'Harbor', 'Ember', 'Frost', 'Nova'];
const KINDS = ['Lamp', 'Backpack', 'Keyboard', 'Mug', 'Headphones', 'Chair', 'Notebook', 'Bottle', 'Speaker', 'Jacket'];

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)]!;
}

function date(r: () => number, startYear = 2022, spanDays = 1000): string {
  const base = Date.UTC(startYear, 0, 1);
  const d = new Date(base + Math.floor(r() * spanDays * 86400000));
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function money(r: () => number, max: number): number {
  return Math.round(r() * max * 100) / 100;
}

function acme(): DemoDatabase[] {
  const N_CUSTOMERS = 400;
  const N_PRODUCTS = 150;
  const N_ORDERS = 2500;
  return [
    {
      name: 'shop',
      tables: [
        {
          name: 'customers',
          ddl: `CREATE TABLE customers (
            id INTEGER PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            first_name VARCHAR(80) NOT NULL,
            last_name VARCHAR(80) NOT NULL,
            country CHAR(2) NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'active',
            is_vip TINYINT(1) NOT NULL DEFAULT 0,
            lifetime_value DECIMAL(10,2) NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(1);
            return Array.from({ length: N_CUSTOMERS }, (_, i) => {
              const f = pick(r, FIRST);
              const l = pick(r, LAST);
              const status = r() < 0.78 ? 'active' : r() < 0.85 ? 'inactive' : 'banned';
              return [i + 1, `${f}.${l}${i + 1}@example.com`.toLowerCase(), f, l, pick(r, COUNTRIES), status, r() < 0.12 ? 1 : 0, money(r, 5000), date(r, 2021)];
            });
          },
        },
        {
          name: 'customer_profiles',
          ddl: `CREATE TABLE customer_profiles (
            customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
            bio TEXT NULL,
            newsletter TINYINT(1) NOT NULL DEFAULT 1,
            preferred_language CHAR(2) NULL
          )`,
          rows: () => {
            const r = rng(2);
            return Array.from({ length: 300 }, (_, i) => [i + 1, r() < 0.3 ? null : `Loves ${pick(r, KINDS).toLowerCase()}s and ${pick(r, WORDS)}.`, r() < 0.6 ? 1 : 0, r() < 0.2 ? null : pick(r, ['en', 'he', 'de', 'fr'])]);
          },
        },
        {
          name: 'categories',
          ddl: `CREATE TABLE categories (
            id INTEGER PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            parent_id INTEGER NULL REFERENCES categories(id)
          )`,
          rows: () => {
            const roots = ['Home', 'Audio', 'Office', 'Outdoor', 'Apparel'];
            const out: unknown[][] = roots.map((n, i) => [i + 1, n, null]);
            KINDS.forEach((k, i) => out.push([roots.length + i + 1, `${k}s`, (i % roots.length) + 1]));
            return out;
          },
        },
        {
          name: 'products',
          ddl: `CREATE TABLE products (
            id INTEGER PRIMARY KEY,
            sku VARCHAR(32) NOT NULL UNIQUE,
            name VARCHAR(200) NOT NULL,
            category_id INTEGER NOT NULL REFERENCES categories(id),
            price DECIMAL(10,2) NOT NULL,
            stock INT NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(3);
            return Array.from({ length: N_PRODUCTS }, (_, i) => {
              const kind = Math.floor(r() * KINDS.length);
              return [i + 1, `SKU-${String(10000 + i)}`, `${pick(r, WORDS)} ${KINDS[kind]}`, 6 + kind, money(r, 400) + 5, Math.floor(r() * 500), r() < 0.9 ? 1 : 0, date(r, 2021)];
            });
          },
        },
        {
          name: 'orders',
          ddl: `CREATE TABLE orders (
            id INTEGER PRIMARY KEY,
            customer_id INTEGER NOT NULL REFERENCES customers(id),
            status VARCHAR(16) NOT NULL,
            total DECIMAL(12,2) NOT NULL,
            currency CHAR(3) NOT NULL DEFAULT 'USD',
            placed_at DATETIME NOT NULL,
            shipped_at DATETIME NULL,
            notes TEXT NULL
          )`,
          rows: () => {
            const r = rng(4);
            const statuses = ['pending', 'paid', 'paid', 'shipped', 'shipped', 'shipped', 'cancelled', 'refunded'];
            return Array.from({ length: N_ORDERS }, (_, i) => {
              const status = pick(r, statuses);
              const placed = date(r, 2023, 650);
              return [i + 1, 1 + Math.floor(r() * N_CUSTOMERS), status, money(r, 900) + 10, pick(r, ['USD', 'USD', 'EUR', 'ILS']), placed, status === 'shipped' ? placed.replace(/^(\d{4}-\d{2}-)(\d{2})/, (_m, a: string, d: string) => `${a}${String(Math.min(28, Number(d) + 2)).padStart(2, '0')}`) : null, r() < 0.1 ? 'Gift wrap please' : null];
            });
          },
        },
        {
          name: 'order_items',
          ddl: `CREATE TABLE order_items (
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id),
            quantity INT NOT NULL,
            unit_price DECIMAL(10,2) NOT NULL,
            PRIMARY KEY (order_id, product_id)
          )`,
          rows: () => {
            const r = rng(5);
            const out: unknown[][] = [];
            for (let o = 1; o <= N_ORDERS; o++) {
              const n = 1 + Math.floor(r() * 4);
              const used = new Set<number>();
              for (let k = 0; k < n; k++) {
                const p = 1 + Math.floor(r() * N_PRODUCTS);
                if (used.has(p)) continue;
                used.add(p);
                out.push([o, p, 1 + Math.floor(r() * 3), money(r, 300) + 5]);
              }
            }
            return out;
          },
        },
        {
          name: 'payments',
          ddl: `CREATE TABLE payments (
            id INTEGER PRIMARY KEY,
            order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
            method VARCHAR(20) NOT NULL,
            amount DECIMAL(12,2) NOT NULL,
            paid_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(6);
            const out: unknown[][] = [];
            let id = 1;
            for (let o = 1; o <= N_ORDERS; o++) if (r() < 0.8) out.push([id++, o, pick(r, ['card', 'card', 'paypal', 'bank_transfer', 'apple_pay']), money(r, 900) + 10, date(r, 2023, 650)]);
            return out;
          },
        },
        {
          name: 'reviews',
          ddl: `CREATE TABLE reviews (
            id INTEGER PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES products(id),
            customer_id INTEGER NOT NULL REFERENCES customers(id),
            rating TINYINT NOT NULL,
            body TEXT NULL,
            created_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(7);
            const bodies = ['Great value!', 'Arrived late but works.', 'Exactly as described.', 'Would not buy again.', 'My kids love it.', null];
            return Array.from({ length: 1200 }, (_, i) => [i + 1, 1 + Math.floor(r() * N_PRODUCTS), 1 + Math.floor(r() * N_CUSTOMERS), 1 + Math.floor(r() * 5), pick(r, bodies), date(r, 2023, 650)]);
          },
        },
      ],
    },
    {
      // Deliberately has no foreign keys: DeepDive must not invent relationships here.
      name: 'analytics',
      tables: [
        {
          name: 'sessions',
          ddl: `CREATE TABLE sessions (
            id VARCHAR(36) PRIMARY KEY,
            customer_id INT NULL,
            device VARCHAR(20) NOT NULL,
            country CHAR(2) NULL,
            started_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(8);
            return Array.from({ length: 1500 }, (_, i) => [`s-${(i + 1).toString(16).padStart(8, '0')}`, r() < 0.4 ? null : 1 + Math.floor(r() * N_CUSTOMERS), pick(r, ['desktop', 'mobile', 'tablet']), r() < 0.05 ? null : pick(r, COUNTRIES), date(r, 2024, 300)]);
          },
        },
        {
          name: 'page_views',
          ddl: `CREATE TABLE page_views (
            id INTEGER PRIMARY KEY,
            session_id VARCHAR(36) NOT NULL,
            url VARCHAR(500) NOT NULL,
            referrer VARCHAR(500) NULL,
            duration_ms INT NOT NULL,
            viewed_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(9);
            const paths = ['/', '/products', '/cart', '/checkout', '/account', '/search?q=lamp', '/blog/launch'];
            return Array.from({ length: 6000 }, (_, i) => [i + 1, `s-${(1 + Math.floor(r() * 1500)).toString(16).padStart(8, '0')}`, `https://acme.example${pick(r, paths)}`, r() < 0.5 ? null : pick(r, ['google', 'newsletter', 'twitter', 'direct']), Math.floor(r() * 120000), date(r, 2024, 300)]);
          },
        },
        {
          name: 'events',
          ddl: `CREATE TABLE events (
            id INTEGER PRIMARY KEY,
            name VARCHAR(64) NOT NULL,
            payload JSON NULL,
            created_at DATETIME NOT NULL
          )`,
          rows: () => {
            const r = rng(10);
            return Array.from({ length: 2000 }, (_, i) => {
              const name = pick(r, ['signup', 'add_to_cart', 'purchase', 'search', 'logout']);
              return [i + 1, name, JSON.stringify({ v: 1, value: Math.floor(r() * 100), source: pick(r, ['web', 'ios', 'android']) }), date(r, 2024, 300)];
            });
          },
        },
        {
          name: 'daily_metrics',
          ddl: `CREATE TABLE daily_metrics (
            day DATE PRIMARY KEY,
            visitors INT NOT NULL,
            orders INT NOT NULL,
            revenue DECIMAL(14,2) NOT NULL
          )`,
          rows: () => {
            const r = rng(11);
            return Array.from({ length: 365 }, (_, i) => {
              const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
              const v = 800 + Math.floor(r() * 1200);
              return [d, v, Math.floor(v * (0.02 + r() * 0.03)), money(r, 40000)];
            });
          },
        },
      ],
    },
    {
      name: 'hr',
      tables: [
        {
          name: 'departments',
          ddl: `CREATE TABLE departments (
            id INTEGER PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            budget DECIMAL(14,2) NULL
          )`,
          rows: () => ['Engineering', 'Design', 'Sales', 'Marketing', 'Support', 'Finance', 'People', 'Legal'].map((n, i) => [i + 1, n, i === 7 ? null : (i + 2) * 125000]),
        },
        {
          name: 'employees',
          ddl: `CREATE TABLE employees (
            id INTEGER PRIMARY KEY,
            department_id INTEGER NOT NULL REFERENCES departments(id),
            manager_id INTEGER NULL REFERENCES employees(id),
            full_name VARCHAR(160) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            title VARCHAR(100) NOT NULL,
            is_remote TINYINT(1) NOT NULL DEFAULT 0,
            hired_at DATE NOT NULL
          )`,
          rows: () => {
            const r = rng(12);
            return Array.from({ length: 120 }, (_, i) => {
              const f = pick(r, FIRST);
              const l = pick(r, LAST);
              return [i + 1, 1 + (i % 8), i < 8 ? null : 1 + (i % 8), `${f} ${l}`, `${f}.${l}.${i + 1}@acme.example`.toLowerCase(), i < 8 ? 'Head of Department' : pick(r, ['Engineer', 'Senior Engineer', 'Manager', 'Specialist', 'Analyst']), r() < 0.4 ? 1 : 0, date(r, 2016, 3000).slice(0, 10)];
            });
          },
        },
        {
          name: 'salary_history',
          ddl: `CREATE TABLE salary_history (
            id INTEGER PRIMARY KEY,
            employee_id INTEGER NOT NULL REFERENCES employees(id),
            amount DECIMAL(12,2) NOT NULL,
            from_date DATE NOT NULL,
            to_date DATE NULL
          )`,
          rows: () => {
            const r = rng(13);
            const out: unknown[][] = [];
            let id = 1;
            for (let e = 1; e <= 120; e++) {
              const n = 1 + Math.floor(r() * 4);
              for (let k = 0; k < n; k++) out.push([id++, e, 60000 + money(r, 90000), `${2018 + k}-01-01`, k === n - 1 ? null : `${2019 + k}-01-01`]);
            }
            return out;
          },
        },
      ],
    },
    { name: 'sandbox', tables: [] },
  ];
}

function lake(): DemoDatabase[] {
  const prefixes = ['fact_sales', 'fact_returns', 'fact_inventory', 'fact_shipments', 'agg_daily', 'agg_weekly', 'stg_orders', 'stg_clicks', 'snap_customers', 'snap_products'];
  const warehouse: DemoTable[] = [
    {
      name: 'dim_store',
      ddl: `CREATE TABLE dim_store (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, region VARCHAR(40) NOT NULL)`,
      rows: () => ['North', 'South', 'East', 'West'].flatMap((reg, i) => [1, 2, 3].map((k) => [i * 3 + k, `${reg} Store ${k}`, reg])),
    },
  ];
  for (const prefix of prefixes) {
    for (let y = 2015; y <= 2024; y++) {
      for (let m = 1; m <= 12; m++) {
        const name = `${prefix}_${y}_${String(m).padStart(2, '0')}`;
        const fk = prefix === 'fact_sales' ? ' REFERENCES dim_store(id)' : '';
        warehouse.push({
          name,
          ddl: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, event_date DATE NOT NULL, store_id INT NOT NULL${fk}, amount DECIMAL(12,2) NULL, note VARCHAR(200) NULL)`,
          rows: () => {
            const r = rng(y * 100 + m + prefix.length);
            return Array.from({ length: 3 }, (_, i) => [i + 1, `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, 1 + Math.floor(r() * 12), money(r, 1000), r() < 0.5 ? null : `batch ${y}${m}`]);
          },
        });
      }
    }
  }
  return [
    { name: 'warehouse', tables: warehouse },
    {
      name: 'staging',
      tables: [
        {
          name: 'raw_imports',
          ddl: `CREATE TABLE raw_imports (id INTEGER PRIMARY KEY, source VARCHAR(50) NOT NULL, payload TEXT NOT NULL, imported_at DATETIME NOT NULL)`,
          rows: () => {
            const r = rng(99);
            return Array.from({ length: 50 }, (_, i) => [i + 1, pick(r, ['s3', 'kafka', 'sftp']), `{"batch":${i}}`, date(r, 2024, 100)]);
          },
        },
      ],
    },
    { name: 'archive', tables: [] },
  ];
}

export function demoDataset(dataset: DemoDataset): DemoDatabase[] {
  return dataset === 'lake' ? lake() : acme();
}
