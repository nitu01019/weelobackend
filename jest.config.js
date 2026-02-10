/**
 * =============================================================================
 * JEST CONFIGURATION - Production Grade
 * =============================================================================
 * 
 * 4 PRINCIPLES COMPLIANCE:
 * SCALABILITY: Fast test execution with proper caching
 * EASY UNDERSTANDING: Clear configuration for backend developers
 * MODULARITY: Separate concerns (unit vs integration tests)
 * CODING STANDARDS: Jest + TypeScript best practices
 * =============================================================================
 */

module.exports = {
  // Use ts-jest for TypeScript support
  preset: 'ts-jest',
  
  // Node environment for backend tests
  testEnvironment: 'node',
  
  // Test file patterns (only .test.ts files)
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  
  // Ignore patterns (exclude dist, node_modules, .d.ts files)
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '\\.d\\.ts$'  // Exclude TypeScript declaration files
  ],
  
  // Module path aliases (if using @ imports)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  
  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts'
  ],
  
  // Coverage threshold (enforce 80% for critical modules)
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 80,
      statements: 80
    }
  },
  
  // Faster test execution
  maxWorkers: '50%',
  
  // Clear mocks between tests
  clearMocks: true,
  
  // Verbose output for debugging
  verbose: true,
  
  // Transform TypeScript files
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  
  // Transform configuration for ts-jest (modern syntax)
  // CODING STANDARDS: Using latest ts-jest configuration pattern
};
