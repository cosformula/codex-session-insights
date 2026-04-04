import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeReportFiles } from '../lib/report.js'
import { createSampleReport } from '../test/fixtures/sample-report.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'test-artifacts', 'sample-report')

const report = createSampleReport()
const { jsonPath, htmlPath } = await writeReportFiles(report, { outDir })

process.stdout.write(`Wrote sample report fixture\nJSON: ${jsonPath}\nHTML: ${htmlPath}\n`)
