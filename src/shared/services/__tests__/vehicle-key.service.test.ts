import { generateVehicleKey, generateVehicleKeyCandidates } from '../vehicle-key.service';

describe('Vehicle key canonicalization', () => {
  it('normalizes type-prefixed subtype variants to the same canonical key', () => {
    const standard = generateVehicleKey('Open', '17 Feet');
    const prefixed = generateVehicleKey('Open', 'Open 17 Feet');

    expect(standard).toBe('open_17_ft');
    expect(prefixed).toBe('open_17_ft');
  });

  it('provides canonical and legacy-compatible key candidates', () => {
    const candidates = generateVehicleKeyCandidates('LCV', 'Open 17 Feet');

    expect(candidates).toContain('lcv_open_17_ft');
    expect(candidates).toContain('lcv_17_ft_open');
  });
});
