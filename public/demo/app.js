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
    // The asset server may serve the page without its extension (/demo/dashboard).
    var onDashboard = /\/dashboard(\.html)?$/.test(location.pathname)
    each('.session-link', function (a) {
      if (user) {
        a.textContent = 'My stays'
        a.setAttribute('href', url('dashboard.html'))
        // The link now leads to the guest area: it is the current page there, and no longer on the sign-in page.
        if (onDashboard && a.closest('.site-nav')) a.setAttribute('aria-current', 'page')
        else a.removeAttribute('aria-current')
      }
    })
    // Phone layout: the "Menu" button opens and closes the navigation under the header.
    var toggle = document.querySelector('.nav-toggle')
    var header = document.querySelector('.site-header')
    var nav = document.querySelector('.site-nav')
    if (toggle && header && nav) {
      var setOpen = function (open) {
        header.classList.toggle('nav-open', open)
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      }
      if ('popover' in HTMLElement.prototype && window.matchMedia) {
        // A native popover while the phone layout applies: the browser closes it on Escape and on a tap
        // outside, and the button opens it declaratively. On wide screens the navigation is a plain row.
        var narrow = window.matchMedia('(max-width: 639px)')
        var sync = function () {
          if (narrow.matches) {
            nav.setAttribute('popover', 'auto')
            toggle.setAttribute('popovertarget', nav.id)
          } else {
            if (nav.hasAttribute('popover') && nav.matches(':popover-open')) nav.hidePopover()
            nav.removeAttribute('popover')
            toggle.removeAttribute('popovertarget')
            setOpen(false)
          }
        }
        nav.addEventListener('beforetoggle', function (event) {
          // The popover is in the top layer: keep it under the header wherever the page is scrolled to.
          if (event.newState === 'open') nav.style.insetBlockStart = Math.max(0, header.getBoundingClientRect().bottom) + 'px'
        })
        nav.addEventListener('toggle', function (event) {
          setOpen(event.newState === 'open')
          // Safari does not focus a clicked button, so after Escape focus would be on <body>.
          if (event.newState === 'closed' && document.activeElement === document.body) toggle.focus()
        })
        if (narrow.addEventListener) narrow.addEventListener('change', sync)
        sync()
      } else {
        // Without the Popover API: the same button toggles a class, and Escape or a press outside closes it.
        toggle.addEventListener('click', function () {
          setOpen(!header.classList.contains('nav-open'))
        })
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape' && header.classList.contains('nav-open')) {
            setOpen(false)
            toggle.focus()
          }
        })
        document.addEventListener('click', function (event) {
          if (header.classList.contains('nav-open') && !header.contains(event.target)) setOpen(false)
        })
        // Leaving the phone layout closes it, as the popover branch does.
        var phone = window.matchMedia && window.matchMedia('(max-width: 639px)')
        if (phone && phone.addEventListener) {
          phone.addEventListener('change', function () {
            if (!phone.matches) setOpen(false)
          })
        }
      }
    }
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
