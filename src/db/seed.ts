import { pool } from './pool.js';
import { hashSecret } from '../auth/crypto.js';

const BANK_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const OPERATOR_ID = '33333333-3333-3333-3333-333333333333';
const REPORTER_ID = '44444444-4444-4444-4444-444444444444';
const PLATFORM_ADMIN_ID = '55555555-5555-5555-5555-555555555555';

const ATMS: Array<{
  id: string;
  siteCode: string;
  name: string;
  region: string;
  district: string;
  town: string;
  lat: number;
  lng: number;
}> = [
  {
    id: 'a1111111-1111-4111-8111-111111111101',
    siteCode: 'NBM-LLW-001',
    name: 'NBM City Centre',
    region: 'Central',
    district: 'Lilongwe',
    town: 'Lilongwe',
    lat: -13.9626,
    lng: 33.7741,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111102',
    siteCode: 'NBM-LLW-002',
    name: 'NBM Area 18',
    region: 'Central',
    district: 'Lilongwe',
    town: 'Lilongwe',
    lat: -13.9502,
    lng: 33.7889,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111103',
    siteCode: 'NBM-LLW-003',
    name: 'NBM Old Town',
    region: 'Central',
    district: 'Lilongwe',
    town: 'Lilongwe',
    lat: -13.9831,
    lng: 33.7574,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111104',
    siteCode: 'NBM-LLW-004',
    name: 'NBM Capital Hill',
    region: 'Central',
    district: 'Lilongwe',
    town: 'Lilongwe',
    lat: -13.9714,
    lng: 33.7892,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111105',
    siteCode: 'NBM-LLW-005',
    name: 'NBM Kanengo',
    region: 'Central',
    district: 'Lilongwe',
    town: 'Lilongwe',
    lat: -13.9205,
    lng: 33.7701,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111106',
    siteCode: 'NBM-BT-001',
    name: 'NBM Victoria Avenue',
    region: 'Southern',
    district: 'Blantyre',
    town: 'Blantyre',
    lat: -15.7861,
    lng: 35.0058,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111107',
    siteCode: 'NBM-BT-002',
    name: 'NBM Limbe',
    region: 'Southern',
    district: 'Blantyre',
    town: 'Limbe',
    lat: -15.8167,
    lng: 35.05,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111108',
    siteCode: 'NBM-BT-003',
    name: 'NBM Chichiri',
    region: 'Southern',
    district: 'Blantyre',
    town: 'Blantyre',
    lat: -15.802,
    lng: 35.021,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111109',
    siteCode: 'NBM-BT-004',
    name: 'NBM Mandala',
    region: 'Southern',
    district: 'Blantyre',
    town: 'Blantyre',
    lat: -15.7912,
    lng: 34.9975,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111110',
    siteCode: 'NBM-MZ-001',
    name: 'NBM Mzuzu Main',
    region: 'Northern',
    district: 'Mzimba',
    town: 'Mzuzu',
    lat: -11.4587,
    lng: 34.0151,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111111',
    siteCode: 'NBM-ZO-001',
    name: 'NBM Zomba Town',
    region: 'Southern',
    district: 'Zomba',
    town: 'Zomba',
    lat: -15.385,
    lng: 35.3188,
  },
  {
    id: 'a1111111-1111-4111-8111-111111111112',
    siteCode: 'NBM-LLW-006',
    name: 'NBM Crossroads',
    region: 'Central',
    district: 'Lilongwe',
    town: 'Lilongwe',
    lat: -13.955,
    lng: 33.7755,
  },
];

export async function seedDatabase() {
  const passwordHash = await hashSecret('ChangeMe123!');
  const pinHash = await hashSecret('1234');

  await pool.query(
    `INSERT INTO banks (id, name, slug, status)
     VALUES ($1, 'National Bank of Malawi', 'nbm', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [BANK_ID],
  );

  const users = [
    {
      id: ADMIN_ID,
      bankId: BANK_ID,
      role: 'bank_admin',
      email: 'admin@nbm.mw',
      employeeId: 'ADM001',
      displayName: 'Bank Admin',
      pin: null as string | null,
    },
    {
      id: OPERATOR_ID,
      bankId: BANK_ID,
      role: 'bank_operator',
      email: 'ops@nbm.mw',
      employeeId: 'OPS001',
      displayName: 'Bank Operator',
      pin: null,
    },
    {
      id: REPORTER_ID,
      bankId: BANK_ID,
      role: 'queue_reporter',
      email: 'reporter@nbm.mw',
      employeeId: 'REP001',
      displayName: 'Queue Reporter',
      pin: pinHash,
    },
    {
      id: PLATFORM_ADMIN_ID,
      bankId: null,
      role: 'platform_admin',
      email: 'platform@atmlocator.mw',
      employeeId: null,
      displayName: 'Platform Admin',
      pin: null,
    },
  ];

  for (const u of users) {
    await pool.query(
      `INSERT INTO users (id, bank_id, role, email, employee_id, display_name, password_hash, pin_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
       ON CONFLICT (id) DO NOTHING`,
      [
        u.id,
        u.bankId,
        u.role,
        u.email,
        u.employeeId,
        u.displayName,
        passwordHash,
        u.pin,
      ],
    );
  }

  for (const atm of ATMS) {
    await pool.query(
      `INSERT INTO atms (
         id, bank_id, site_code, name, region, district, town, lat, lng, status, hours_json, active_lanes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'operational',$10,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        atm.id,
        BANK_ID,
        atm.siteCode,
        atm.name,
        atm.region,
        atm.district,
        atm.town,
        atm.lat,
        atm.lng,
        JSON.stringify({ summary: 'Mon–Fri 08:00–17:00' }),
      ],
    );

    await pool.query(
      `INSERT INTO atm_services (atm_id, service_code, available) VALUES
       ($1,'cash_withdrawal',true),
       ($1,'balance_enquiry',true),
       ($1,'mini_statement',true)
       ON CONFLICT DO NOTHING`,
      [atm.id],
    );
    await pool.query(
      `INSERT INTO atm_card_brands (atm_id, brand_code, supported) VALUES
       ($1,'visa',true),
       ($1,'mastercard',true),
       ($1,'natswitch',true)
       ON CONFLICT DO NOTHING`,
      [atm.id],
    );
  }

  console.log('seed complete');
  console.log('dev passwords: ChangeMe123! (all users); reporter PIN: 1234');
}

export const seedIds = {
  BANK_ID,
  ADMIN_ID,
  OPERATOR_ID,
  REPORTER_ID,
  PLATFORM_ADMIN_ID,
  ATMS,
};

const isMain = process.argv[1]?.includes('seed');
if (isMain) {
  seedDatabase()
    .then(async () => {
      await pool.end();
    })
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
