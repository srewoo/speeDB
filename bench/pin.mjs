#!/usr/bin/env node
/**
 * Resolve every unpinned repo in `repos.json` to a commit SHA.
 *
 * An unpinned benchmark is not reproducible, and a benchmark you cannot
 * reproduce cannot show a regression — so `score.mjs` refuses to score one and
 * this is the one command that fixes it.
 *
 *   node bench/pin.mjs                     pin everything still null
 *   node bench/pin.mjs --repo discourse    pin one
 *   node bench/pin.mjs --force             re-pin, INVALIDATING truth files
 *
 * Moving a pinned SHA invalidates the audit for that repo, because truth files
 * are keyed by SHA precisely so a moved pin cannot silently pass off an old
 * audit as a current one. `--force` says so and asks you to re-audit.
 *
 * Tokens, if the repo is private: GITHUB_TOKEN / GITLAB_TOKEN.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BENCH = import.meta.dirname
const configPath = resolve(BENCH, 'repos.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))

const argv = process.argv.slice(2)
const only = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : null
const force = argv.includes('--force')

let changed = 0

for (const repo of config.repos) {
  if (only && repo.id !== only) continue
  if (repo.sha && !force) continue

  const branch = repo.branch ?? 'HEAD'
  try {
    const sha = repo.forge === 'gitlab'
      ? await gitlabSha(repo.repo, branch)
      : await githubSha(repo.repo, branch)

    if (repo.sha === sha) {
      console.log(`= ${repo.id} already at ${sha.slice(0, 10)}`)
      continue
    }

    if (repo.sha && force) {
      const truth = resolve(BENCH, 'truth', repo.id, `${repo.sha}.json`)
      if (existsSync(truth)) {
        console.warn(
          `! ${repo.id}: re-pinned from ${repo.sha.slice(0, 10)} to ${sha.slice(0, 10)}. ` +
          `The audit at bench/truth/${repo.id}/${repo.sha}.json no longer applies to the pinned ` +
          `commit — re-run bench/AUDIT_PROMPT.md before trusting a score for this repo.`,
        )
      }
    }

    repo.sha = sha
    changed++
    console.log(`+ ${repo.id} -> ${sha}`)
  } catch (e) {
    console.error(`x ${repo.id}: ${e.message}`)
  }
}

if (changed > 0) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`\nUpdated ${changed} entry(ies) in bench/repos.json. Commit it — the pin is the point.`)
} else {
  console.log('\nNothing to pin.')
}

async function githubSha(slug, ref) {
  const headers = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const url = ref === 'HEAD'
    ? `https://api.github.com/repos/${slug}/commits?per_page=1`
    : `https://api.github.com/repos/${slug}/commits/${encodeURIComponent(ref)}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${slug}`)
  const body = await res.json()
  const sha = Array.isArray(body) ? body[0]?.sha : body?.sha
  if (!sha) throw new Error(`no commit returned for ${slug}`)
  return sha
}

async function gitlabSha(slug, ref) {
  const headers = {}
  if (process.env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN
  const id = encodeURIComponent(slug)
  const url = ref === 'HEAD'
    ? `https://gitlab.com/api/v4/projects/${id}/repository/commits?per_page=1`
    : `https://gitlab.com/api/v4/projects/${id}/repository/commits/${encodeURIComponent(ref)}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitLab ${res.status} for ${slug}`)
  const body = await res.json()
  const sha = Array.isArray(body) ? body[0]?.id : body?.id
  if (!sha) throw new Error(`no commit returned for ${slug}`)
  return sha
}
