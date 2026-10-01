// The Chrome extension's handling of the DevTools protocol (#357): screenshots
// at one pixel per CSS pixel, Chrome's errors as CDP errors, the events sent
// up cut to what Grove reads, and the pages it can't drive.

import { describe, expect, test } from 'bun:test'
import {
  FORWARDED_EVENTS,
  cssPixelScreenshotParams,
  describeCommand,
  isDrivableUrl,
  parseCdpError,
  slimEvent
} from '../resources/chrome-extension/cdp.js'

const hiDpiViewport = { devicePixelRatio: 2, pageX: 0, pageY: 300, width: 1280, height: 720 }

describe('screenshots', () => {
  test('on a HiDPI screen the viewport is captured scaled to CSS pixels', () => {
    expect(cssPixelScreenshotParams({ format: 'png' }, hiDpiViewport)).toEqual({
      format: 'png',
      clip: { x: 0, y: 300, width: 1280, height: 720, scale: 0.5 }
    })
  })

  test('a clip the agent gave keeps its region, scaled the same way', () => {
    const clip = { x: 10, y: 20, width: 100, height: 50, scale: 1 }
    expect(cssPixelScreenshotParams({ clip }, hiDpiViewport)).toEqual({ clip: { ...clip, scale: 0.5 } })
  })

  test('at one device pixel per CSS pixel nothing changes', () => {
    expect(cssPixelScreenshotParams({ format: 'jpeg' }, { ...hiDpiViewport, devicePixelRatio: 1 })).toEqual({ format: 'jpeg' })
  })
})

describe('errors', () => {
  test('the protocol’s error in Chrome’s message keeps its code and message', () => {
    const error = parseCdpError(new Error(JSON.stringify({ code: -32601, message: "'Nope.method' wasn't found" })))
    expect(error.message).toBe("'Nope.method' wasn't found")
    expect((error as Error & { code: number }).code).toBe(-32601)
  })

  test('Chrome’s own error is a server error with its text', () => {
    const error = parseCdpError(new Error('Debugger is not attached to the tab with id: 4.'))
    expect(error.message).toBe('Debugger is not attached to the tab with id: 4.')
    expect((error as Error & { code: number }).code).toBe(-32000)
  })
})

describe('events sent to Grove', () => {
  test('are the ones Grove reads', () => {
    expect([...FORWARDED_EVENTS].sort()).toEqual([
      'Network.loadingFailed',
      'Network.requestWillBeSent',
      'Network.responseReceived',
      'Page.frameNavigated',
      'Page.navigatedWithinDocument',
      'Runtime.consoleAPICalled',
      'Runtime.exceptionThrown'
    ])
  })

  test('a request keeps its method and url, not its body or headers', () => {
    const slim = slimEvent('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Fetch',
      request: { method: 'POST', url: 'http://x/api', headers: { a: 'b' }, postData: 'x'.repeat(10000) }
    })
    expect(slim).toEqual({ requestId: 'r1', type: 'Fetch', request: { method: 'POST', url: 'http://x/api' } })
  })

  test('a data: URL is cut short', () => {
    const slim = slimEvent('Network.responseReceived', {
      requestId: 'r1',
      response: { url: `data:image/png;base64,${'A'.repeat(100000)}`, status: 200, headers: {} }
    }) as { response: { url: string } }
    expect(slim.response.url.length).toBeLessThan(2100)
  })

  test('a console call keeps its arguments’ values and the top stack frame', () => {
    const slim = slimEvent('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'boom', preview: { properties: [] } }],
      stackTrace: { callFrames: [{ url: 'http://x/app.js', lineNumber: 3, functionName: 'f' }, { url: 'http://x/b.js' }] },
      executionContextId: 1
    })
    expect(slim).toEqual({
      type: 'error',
      args: [{ type: 'string', value: 'boom' }],
      stackTrace: { callFrames: [{ url: 'http://x/app.js', lineNumber: 3 }] }
    })
  })
})

describe('the popup’s words for what the agent does', () => {
  test('acting on the page is described, reading it is not', () => {
    expect(describeCommand('Page.navigate', { url: 'http://x/' })).toBe('Opening http://x/')
    expect(describeCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10.4, y: 20.6 })).toBe('Clicking at 10,21')
    expect(describeCommand('Page.captureScreenshot', {})).toBe('Taking a screenshot')
    expect(describeCommand('Runtime.evaluate', { expression: '1' })).toBeNull()
  })
})

describe('pages Chrome won’t let the extension drive', () => {
  test('its own pages and the web store are refused, the web is not', () => {
    expect(isDrivableUrl('chrome://settings')).toBe(false)
    expect(isDrivableUrl('https://chromewebstore.google.com/detail/x')).toBe(false)
    expect(isDrivableUrl('http://localhost:3000/')).toBe(true)
    expect(isDrivableUrl('about:blank')).toBe(true)
  })
})
