export interface VehicleCatalogTypeEntry {
  type: string;
  name: string;
  subtypes: string[];
}

const VEHICLE_TYPES_CATALOG: VehicleCatalogTypeEntry[] = [
  { type: 'mini', name: 'Mini/Pickup', subtypes: ['Tata Ace', 'Dost', 'Mahindra Bolero'] },
  { type: 'lcv', name: 'LCV', subtypes: ['14ft Open', '17ft Open', '19ft Open', '14ft Container', '17ft Container'] },
  { type: 'open', name: 'Open Truck', subtypes: ['14 Feet', '17 Feet', '19 Feet', '20 Feet', '22 Feet', '24 Feet'] },
  { type: 'container', name: 'Container', subtypes: ['19 Feet', '20 Feet', '24 Feet', '32 Feet Single', '32 Feet Multi'] },
  { type: 'trailer', name: 'Trailer', subtypes: ['20-22 Ton', '23-25 Ton', '26-28 Ton', '32-35 Ton'] },
  { type: 'tipper', name: 'Tipper', subtypes: ['9-11 Ton', '15-17 Ton', '20-24 Ton', '25+ Ton'] },
  { type: 'tanker', name: 'Tanker', subtypes: ['12-15 Ton', '16-20 Ton', '21-25 Ton', '30+ Ton'] },
  { type: 'bulker', name: 'Bulker', subtypes: ['20-22 Ton', '23-25 Ton', '26-28 Ton', '32+ Ton'] },
  { type: 'dumper', name: 'Dumper', subtypes: ['9-11 Ton', '16-19 Ton', '20-25 Ton', '30+ Ton'] },
  { type: 'tractor', name: 'Tractor Trolley', subtypes: ['Single Trolley', 'Double Trolley'] }
];

export function getVehicleTypesCatalog(): VehicleCatalogTypeEntry[] {
  return VEHICLE_TYPES_CATALOG.map((entry) => ({
    ...entry,
    subtypes: [...entry.subtypes]
  }));
}
