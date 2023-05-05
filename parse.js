const fs = require('fs')
const cheerio = require('cheerio')

const QUOTE = '<|>'

const cleanupEmail = (str) => {
  if (!str) {
    return
  }
  let lines = str
    // .replace(/^> >.+\n/g, '')
    // .replace(/^>\n/g, '')
    .replace(/  +/g, ' ')
    .split('\n')
    .map(l => l.trim())
  
  lines = lines.filter(l =>
    !!l &&
    !l.startsWith('>') &&
    !l.includes(' wrote:') &&
    !/^[A-Z][A-Za-z. ]+:$/.test(l)
  )
  const sig = lines.indexOf('---------------------------------------------------------------------')
  if (sig !== -1) {
    // Remove their name too
    lines.length = sig - 1
  }
  return lines.join('\n')
    .replace(/([a-z0-9])\n([a-z0-9])/g, '$1 $2')
}

const parseEmails = () => {
  const emails = require('./nakamotoinstitute.org/emails.json')
  const out = []
  for (const email of emails) {
    if (email.sender !== 'Satoshi Nakamoto') {
      continue
    }
    const q = cleanupEmail(emails.find(p => p.id === email.parent)?.text)
    if (q) {
      out.push({
        date: email.date, src: email.url,
        // TODO: It needs a logic like the other, he answers inline many times >>
        q,
        a: cleanupEmail(email.text),
      })
    }
  }
  
  fs.writeFileSync('./data/emails.json', JSON.stringify(out, null, '\t'))
  return out
}

const splitPost = (html) => {
  const $ = cheerio.load(html)
  $('.quoteheader,.codeheader,img,del').remove()
  $('br').replaceWith('\n')
  $('.code,a').each((_, e) => {
    $(e).replaceWith(e.childNodes)
  })
  $('.quote').each((_, e) => {
    $(e).text(QUOTE + $(e).text() + QUOTE)
  })
  return $.text()
    .replace(/EDIT: ?/g, '')
    .replace(/\\u\w+/g, '')
    .replace(/ /g, ' ').replace(/  +/g, ' ')
    .split('\n').map(p => p.trim()).filter(p =>
      !!p &&
      !p.includes('Posted:') &&
      !p.includes('-------------') &&
      !/^[a-z]+:$/.test(p)
    ).join('\n')
    .split(QUOTE)
    .map(p => p.trim())
}

const parsePosts = () => {
  const posts = require('./nakamotoinstitute.org/posts.json')  
  const out = []
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]
    if (!post.satoshi_id) {
      continue
    }
    const [first, ...parts] = splitPost(post.content)
    if (first) {
      const prev = posts.find(p => p.thread_id === post.thread_id && p.post_num === post.post_num - 1)
      if (prev) {
        const prevParts = splitPost(prev.content)
        const q = prevParts.pop() || prevParts[0]
        if (q) {
          parts.unshift(q.trim(), first)
        }
      }
    }
    for (let j = 0; j < parts.length; j += 2) {
      if (parts[j + 1]) {
        out.push({ date: post.date, src: post.url, q: parts[j], a: parts[j + 1] })
      }
    }
  }
  
  fs.writeFileSync('./data/posts.json', JSON.stringify(out, null, '\t'))
  return out
}

const items = parsePosts().concat(parseEmails())
  .map(({ date, ...e }, id) => ({
    id, date: new Date(date + ' UTC').toISOString().split('.')[0].replace('T', ' '), ...e
  }))
  .sort((a, b) => a.date - b.date)
  .map(e => ({ ...e, qlen: e.q.length, alen: e.a.length }))
  .map(e => ({ ...e, len: e.qlen + e.alen }))

fs.writeFileSync('./data/all.json', JSON.stringify(items, null, '\t'))
