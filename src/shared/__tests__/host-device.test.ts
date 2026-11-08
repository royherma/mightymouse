import { describe, expect, it } from 'vitest'
import { hostDeviceFrom } from '../phone-remote-keys'

describe('hostDeviceFrom', () => {
  it.each([
    ['MacBook Pro', 'MacBookPro18,3', 'macbook-pro', true],
    ['MacBook Pro', 'Mac15,3', 'macbook-pro', true],
    ['MacBook Pro', 'Mac14,7', 'macbook-pro', false],
    ['MacBook Pro', 'MacBookPro17,1', 'macbook-pro', false],
    ['MacBook Pro', 'MacBookPro16,1', 'macbook-pro', false],
    ['MacBook Air', 'Mac14,2', 'macbook-air', true],
    ['MacBook Air', 'Mac15,12', 'macbook-air', true],
    ['MacBook Air', 'MacBookAir10,1', 'macbook-air', false]
  ])('%s %s is a %s frame, notch %s', (name, model, frame, notch) => {
    expect(hostDeviceFrom(name, model)).toEqual({ frame, name, notch })
  })

  it.each([
    ['iMac', 'Mac15,4'],
    ['Mac mini', 'Mac14,3'],
    ['Mac Studio', 'Mac13,1'],
    ['Mac Pro', 'Mac14,8']
  ])('%s is a desktop with no notch, whatever its model id', (name, model) => {
    expect(hostDeviceFrom(name, model)).toEqual({ frame: 'desktop', name, notch: false })
  })

  it('an empty profiler answer is a plain Mac laptop with no notch', () => {
    expect(hostDeviceFrom('  ', '')).toEqual({ frame: 'macbook-pro', name: 'Mac', notch: false })
  })
})
