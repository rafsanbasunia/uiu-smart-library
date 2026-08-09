import postgres from 'postgres'
import { BOOKS, JOURNALS, THESES, EXTRA_AUTHORS, INTERESTS, SUMMARY_TEMPLATES } from './data/books.mjs'

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false })

// deterministic PRNG so every reseed produces the same demo
let s = 20260920
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = (a) => a[Math.floor(rnd() * a.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const chance = (p) => rnd() < p
const days = (n) => new Date(Date.now() + n * 86400000)

const ZONES = ['Ground Floor — Reading Hall', 'First Floor — Stacks A', 'First Floor — Stacks B', 'Second Floor — Reference', 'Second Floor — Periodicals']
const HUES = [8, 24, 38, 150, 176, 200, 215, 258, 285, 330]

const FIRST = ['Mahedi', 'Mostafizur', 'Minhazul', 'Rafsan', 'Nusrat', 'Farhana', 'Tanvir', 'Sabbir', 'Ayesha', 'Imran', 'Sharmin', 'Zubair', 'Nabila', 'Arif', 'Rafiul', 'Mehjabin', 'Tasnim', 'Shakib', 'Anika', 'Rakibul', 'Sadia', 'Fahim', 'Ishrat', 'Naimur', 'Tahmid', 'Lamia', 'Sourav', 'Maliha', 'Rizwan', 'Samiha', 'Asif', 'Jarin', 'Nafis', 'Prottoy', 'Ridwan', 'Sumaiya']
const LAST = ['Hasan', 'Rahman', 'Hoque', 'Basunia', 'Jahan', 'Akter', 'Ahmed', 'Hossain', 'Siddika', 'Kabir', 'Sultana', 'Islam', 'Karim', 'Mahmud', 'Chowdhury', 'Alam', 'Khan', 'Bhuiyan', 'Sarker', 'Mia', 'Das', 'Roy']
const DEPTS = ['CSE', 'EEE', 'BBA', 'Economics', 'Civil Engineering', 'Pharmacy', 'English']

const COURSES = [
  ['CSE 2215', 'Data Structures and Algorithms I', 'CSE'],
  ['CSE 3411', 'System Analysis and Design Laboratory', 'CSE'],
  ['CSE 3421', 'Database Management Systems', 'CSE'],
  ['CSE 4531', 'Computer Security', 'CSE'],
  ['CSE 4633', 'Machine Learning', 'CSE'],
  ['CSE 3521', 'Computer Networks', 'CSE'],
  ['EEE 2101', 'Electrical Circuits I', 'EEE'],
  ['EEE 3101', 'Signals and Systems', 'EEE'],
  ['EEE 4101', 'Power System Analysis', 'EEE'],
  ['BBA 2101', 'Principles of Marketing', 'BBA'],
  ['BBA 3203', 'Managerial Accounting', 'BBA'],
  ['BBA 4101', 'Strategic Management', 'BBA'],
  ['ECO 2101', 'Principles of Economics', 'Economics'],
  ['ECO 3301', 'Development Economics', 'Economics'],
  ['CE 2101', 'Engineering Mechanics', 'Civil Engineering'],
  ['PHR 2101', 'Pharmacology I', 'Pharmacy'],
  ['ENG 1011', 'English Composition', 'English'],
  ['MATH 1151', 'Calculus and Analytical Geometry', 'CSE'],
]

const ROOMS = [
  ['Discussion Room 1', 6, 'First Floor', ['Whiteboard', 'Power sockets']],
  ['Discussion Room 2', 6, 'First Floor', ['Whiteboard', 'Power sockets']],
  ['Group Study Room A', 8, 'Second Floor', ['Display screen', 'Whiteboard']],
  ['Group Study Room B', 8, 'Second Floor', ['Display screen', 'Power sockets']],
  ['Silent Study Pod', 4, 'Second Floor', ['Quiet zone']],
  ['Seminar Room', 20, 'Ground Floor', ['Projector', 'Whiteboard', 'AC']],
]

const slug = (n) => Math.random().toString(36).slice(2, 10) + n

async function main() {
  console.log('clearing…')
  await sql.unsafe(`truncate notifications, occupancy_readings, room_bookings, rooms,
    course_reserves, saved_searches, bookmarks, reading_list_items, reading_lists,
    reco_settings, user_interests, interests, ratings, ledger_entries, payments,
    fines, holds, loans, loan_rules, digital_assets, copies, title_subjects,
    subjects, title_authors, authors, titles, enrollments, courses, users restart identity cascade`)

  // ------------------------------------------------------------ loan rules
  await sql`insert into loan_rules ${sql([
    { role: 'student', max_items: 5, loan_days: 14, max_renewals: 2 },
    { role: 'faculty', max_items: 12, loan_days: 30, max_renewals: 3 },
    { role: 'staff', max_items: 12, loan_days: 30, max_renewals: 3 },
  ])}`

  // ------------------------------------------------------------ users
  const team = [
    ['Mahedi Hasan Sorol', 'student', 'CSE'],
    ['Mostafizur Rahman Murad', 'student', 'CSE'],
    ['Md Minhazul Hoque', 'student', 'CSE'],
    ['Rafsan Hossen Basunia', 'student', 'CSE'],
  ]
  const userRows = []
  let sid = 11220001
  for (const [name, role, dept] of team) {
    userRows.push({ uiu_id: String(sid++), name, email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@bscse.uiu.ac.bd', role, department: dept, avatar_hue: pick(HUES) })
  }
  for (let i = 0; i < 40; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`
    userRows.push({ uiu_id: String(sid++), name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@bscse.uiu.ac.bd`, role: 'student', department: pick(DEPTS), avatar_hue: pick(HUES) })
  }
  const faculty = [
    ['Dr. Salekul Islam', 'CSE'], ['Dr. Mohammad Nurul Huda', 'CSE'],
    ['Dr. Khondaker Abdullah-Al-Mamun', 'CSE'], ['Dr. Rashedur M Rahman', 'EEE'],
    ['Dr. Farhana Yasmin', 'BBA'], ['Dr. Mohammed Masum Iqbal', 'Economics'],
  ]
  let fid = 20010
  for (const [name, dept] of faculty) {
    userRows.push({ uiu_id: String(fid++), name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@uiu.ac.bd`, role: 'faculty', department: dept, avatar_hue: pick(HUES) })
  }
  const staff = [['Shirin Akter', 'Circulation Desk'], ['Abdul Karim', 'Technical Services'], ['Rokeya Begum', 'Library Administration']]
  let stid = 30010
  for (const [name, dept] of staff) {
    userRows.push({ uiu_id: String(stid++), name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@lib.uiu.ac.bd`, role: 'staff', department: dept, avatar_hue: pick(HUES) })
  }
  const users = await sql`insert into users ${sql(userRows)} returning *`
  const students = users.filter((u) => u.role === 'student')
  const facultyU = users.filter((u) => u.role === 'faculty')
  const staffU = users.filter((u) => u.role === 'staff')
  console.log(`users: ${users.length}`)

  // ------------------------------------------------------------ courses
  const courses = await sql`insert into courses ${sql(COURSES.map(([code, title, dept]) => ({ code, title, semester: 'Fall 2026', dept })))} returning *`
  const enr = []
  for (const st of students) {
    const mine = courses.filter((c) => c.dept === st.department)
    const chosen = (mine.length ? mine : courses).slice(0, 5).filter(() => chance(0.7))
    for (const c of (chosen.length ? chosen : [pick(courses)])) enr.push({ user_id: st.id, course_id: c.id })
  }
  for (const f of facultyU) enr.push({ user_id: f.id, course_id: pick(courses).id })
  await sql`insert into enrollments ${sql(enr)} on conflict do nothing`

  // ------------------------------------------------------------ interests
  const interests = await sql`insert into interests ${sql(INTERESTS.map((name) => ({ name })))} returning *`

  // ------------------------------------------------------------ catalogue
  const allTitles = []
  for (const [title, author, year, publisher, type, subjects] of BOOKS) allTitles.push({ title, author, year, publisher, type, subjects })
  for (const [title, author, year, publisher, subjects] of JOURNALS) allTitles.push({ title, author, year, publisher, type: 'journal', subjects })
  for (const [title, author, year, dept, subjects] of THESES) allTitles.push({ title, author, year, publisher: `United International University — ${dept}`, type: 'thesis', subjects })

  const titleRows = allTitles.map((t, i) => ({
    type: t.type,
    title: t.title,
    subtitle: t.type === 'thesis' ? `${t.publisher.split('— ')[1]} undergraduate thesis` : null,
    isbn: t.type === 'print' || t.type === 'ebook' ? `978-${int(0, 9)}-${int(100, 999)}-${int(10000, 99999)}-${int(0, 9)}` : null,
    issn: t.type === 'journal' ? `${int(1000, 9999)}-${int(1000, 9999)}` : null,
    publisher: t.publisher,
    year: t.year,
    language: 'English',
    edition: t.type === 'print' && chance(0.5) ? `${int(2, 12)}th edition` : null,
    pages: t.type === 'journal' ? null : int(180, 1180),
    summary: pick(SUMMARY_TEMPLATES),
    cover_hue: HUES[i % HUES.length],
    added_at: days(-int(30, 1400)),
  }))
  const titles = await sql`insert into titles ${sql(titleRows)} returning id, title, type`
  console.log(`titles: ${titles.length}`)
  const byTitle = new Map(titles.map((t) => [t.title, t]))

  // authors
  const authorNames = new Set()
  for (const t of allTitles) {
    authorNames.add(t.author)
    for (const e of EXTRA_AUTHORS[t.title] ?? []) authorNames.add(e)
  }
  const authors = await sql`insert into authors ${sql([...authorNames].map((name) => ({ name })))} returning *`
  const authorId = new Map(authors.map((a) => [a.name, a.id]))
  const ta = []
  for (const t of allTitles) {
    const row = byTitle.get(t.title)
    ta.push({ title_id: row.id, author_id: authorId.get(t.author), ord: 0 })
    let o = 1
    for (const e of EXTRA_AUTHORS[t.title] ?? []) ta.push({ title_id: row.id, author_id: authorId.get(e), ord: o++ })
  }
  await sql`insert into title_authors ${sql(ta)} on conflict do nothing`

  // subjects
  const subjectNames = new Set()
  for (const t of allTitles) t.subjects.forEach((x) => subjectNames.add(x))
  const subjects = await sql`insert into subjects ${sql([...subjectNames].map((name) => ({ name })))} returning *`
  const subjectId = new Map(subjects.map((x) => [x.name, x.id]))
  const ts = []
  for (const t of allTitles) for (const x of t.subjects) ts.push({ title_id: byTitle.get(t.title).id, subject_id: subjectId.get(x) })
  await sql`insert into title_subjects ${sql(ts)} on conflict do nothing`

  // copies
  const copyRows = []
  let acc = 100001
  for (const t of allTitles) {
    const row = byTitle.get(t.title)
    if (t.type === 'ebook') continue
    const n = t.type === 'thesis' ? 1 : t.type === 'journal' ? int(2, 4) : int(2, 6)
    const zone = t.type === 'journal' ? ZONES[4] : t.type === 'thesis' ? ZONES[3] : pick(ZONES.slice(0, 3))
    for (let i = 0; i < n; i++) {
      copyRows.push({
        title_id: row.id,
        accession_number: `UIU-${acc++}`,
        location_zone: zone,
        shelf_bay: `${String.fromCharCode(65 + int(0, 7))}-${int(1, 24)}`,
        copy_type: t.type === 'thesis' || t.type === 'journal' ? 'reference' : i === 0 && chance(0.2) ? 'reserve' : 'circulating',
        status: 'available',
      })
    }
  }
  const copies = await sql`insert into copies ${sql(copyRows)} returning *`
  console.log(`copies: ${copies.length}`)

  // digital assets for ebooks
  const ebooks = titles.filter((t) => t.type === 'ebook')
  if (ebooks.length) {
    await sql`insert into digital_assets ${sql(ebooks.map((t) => ({ title_id: t.id, format: 'pdf', url: null, access_rule: 'campus' })))}`
  }

  // ------------------------------------------------------------ loans
  const circulating = copies.filter((c) => c.copy_type === 'circulating')
  const loanRows = []
  const taken = new Set()
  // historical, returned loans — these feed recommendations
  for (let i = 0; i < 420; i++) {
    const c = pick(circulating)
    const u = pick(students.concat(facultyU))
    const issued = days(-int(30, 400))
    const due = new Date(issued.getTime() + 14 * 86400000)
    loanRows.push({ copy_id: c.id, title_id: c.title_id, user_id: u.id, issued_at: issued, due_at: due, returned_at: new Date(due.getTime() - int(-4, 10) * 86400000), renewals_count: int(0, 2), issued_by: pick(staffU).id })
  }
  // open loans
  const openLoans = []
  for (let i = 0; i < 95; i++) {
    const c = pick(circulating)
    if (taken.has(c.id)) continue
    taken.add(c.id)
    const u = pick(students.concat(facultyU))
    const offset = int(-24, 12)
    const issued = days(offset - 14)
