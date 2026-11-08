export default function setup() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`better-sqlite3 13 needs Node 22+, this is ${process.version}. Run: nvm use 22`)
}
