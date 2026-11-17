// Harbor Inn demo site helpers. Plain JS, no build step.
// ?ui=v2 simulates a redesign of the same site (renamed ids, changed copy, extra wrappers).
(function () {
  var v2 = new URLSearchParams(location.search).get('ui') === 'v2'

  function url(path) {
    if (!v2 || /^(https?:|#|mailto:)/.test(path)) return path
    var hash = ''
    var i = path.indexOf('#')
    if (i >= 0) {
      hash = path.slice(i)
      path = path.slice(0, i)
    }
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'ui=v2' + hash
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn)
  }

  // Applies the declarative data-v2-* hints (v2 only) and strips them (always),
  // so the served DOM carries no trace of the other design.
  function ready() {
    each('[data-v2-id]', function (el) {
      var next = el.getAttribute('data-v2-id')
      if (v2) {
        var old = el.id
        each('label[for="' + old + '"]', function (label) {
          label.setAttribute('for', next)
        })
        el.id = next
      }
      el.removeAttribute('data-v2-id')
    })
    each('[data-v2-name]', function (el) {
      if (v2) el.setAttribute('name', el.getAttribute('data-v2-name'))
      el.removeAttribute('data-v2-name')
    })
    each('[data-v2-text]', function (el) {
      if (v2) el.textContent = el.getAttribute('data-v2-text')
      el.removeAttribute('data-v2-text')
    })
    each('[data-v2-class]', function (el) {
      if (v2) el.className = el.getAttribute('data-v2-class')
      el.removeAttribute('data-v2-class')
    })
    each('[data-v2-wrap]', function (el) {
      if (v2) {
        var wrapper = document.createElement('div')
        wrapper.className = el.getAttribute('data-v2-wrap')
        el.parentNode.insertBefore(wrapper, el)
        wrapper.appendChild(el)
      }
      el.removeAttribute('data-v2-wrap')
    })
    if (v2) {
      document.body.classList.add('theme-v2')
      each('a[href]', function (a) {
        var href = a.getAttribute('href')
        if (/\.html(#.*)?$/.test(href)) a.setAttribute('href', url(href))
      })
    }
    var user = getUser()
    each('.session-link', function (a) {
      if (user) {
        a.textContent = 'My stays'
        a.setAttribute('href', url('dashboard.html'))
      }
    })
    document.documentElement.classList.add('ready')
  }

  function getUser() {
    try {
      return JSON.parse(sessionStorage.getItem('harbor.user') || 'null')
    } catch (e) {
      return null
    }
  }

  window.Harbor = {
    v2: v2,
    url: url,
    ready: ready,
    go: function (path) {
      location.href = url(path)
    },
    getUser: getUser,
    setUser: function (user) {
      if (user) sessionStorage.setItem('harbor.user', JSON.stringify(user))
      else sessionStorage.removeItem('harbor.user')
    },
    money: function (n) {
      return '$' + n.toFixed(2)
    },
    PLANS: {
      standard: { label: 'Standard room', rate: 120 },
      deluxe: { label: 'Deluxe harbor view', rate: 180 },
      suite: { label: 'Captain’s suite', rate: 260 },
    },
    BREAKFAST_RATE: 15,
  }
})()
