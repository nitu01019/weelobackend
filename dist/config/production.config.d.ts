/**
 * =============================================================================
 * PRODUCTION CONFIGURATION - AWS Deployment Ready
 * =============================================================================
 *
 * Configuration for deploying to AWS with:
 * - ECS/Fargate for containers
 * - ElastiCache for Redis
 * - RDS for database (future)
 * - ALB for load balancing
 * - CloudWatch for logging
 *
 * SCALABILITY SETTINGS:
 * - Connection pooling
 * - Rate limiting
 * - Cache TTLs
 * - WebSocket limits
 *
 * =============================================================================
 */
export declare const productionConfig: {
    server: {
        port: number;
        host: string;
        trustProxy: boolean;
        requestTimeout: number;
        keepAliveTimeout: number;
        headersTimeout: number;
    };
    cors: {
        origins: string[];
        methods: string[];
        allowedHeaders: string[];
        credentials: boolean;
        maxAge: number;
    };
    rateLimit: {
        global: {
            windowMs: number;
            max: number;
        };
        auth: {
            windowMs: number;
            max: number;
        };
        booking: {
            windowMs: number;
            max: number;
        };
        websocket: {
            maxConnectionsPerUser: number;
            reconnectCooldownMs: number;
        };
    };
    cache: {
        redis: {
            enabled: boolean;
            url: string;
            maxRetries: number;
            connectTimeout: number;
            commandTimeout: number;
        };
        memory: {
            maxSize: number;
            defaultTTL: number;
        };
        ttl: {
            transportersByVehicle: number;
            userProfile: number;
            fcmToken: number;
            otp: number;
            refreshToken: number;
            activeBookings: number;
        };
    };
    database: {
        type: string;
        postgres: {
            host: string | undefined;
            port: number;
            database: string | undefined;
            username: string | undefined;
            password: string | undefined;
            pool: {
                min: number;
                max: number;
                acquireTimeout: number;
                idleTimeout: number;
            };
            ssl: boolean;
        };
    };
    websocket: {
        pingTimeout: number;
        pingInterval: number;
        maxHttpBufferSize: number;
        adapter: string;
        maxRoomsPerSocket: number;
        transports: string[];
        upgradeTimeout: number;
    };
    fcm: {
        batchSize: number;
        retries: number;
        retryDelay: number;
        timeout: number;
    };
    security: {
        jwt: {
            accessTokenExpiry: string;
            refreshTokenExpiry: string;
            algorithm: string;
        };
        maxRequestSize: string;
        maxUrlLength: number;
        helmet: {
            contentSecurityPolicy: boolean;
            crossOriginEmbedderPolicy: boolean;
            hsts: {
                maxAge: number;
                includeSubDomains: boolean;
                preload: boolean;
            };
        };
    };
    logging: {
        level: string;
        format: string;
        requestLogging: {
            enabled: boolean;
            excludePaths: string[];
            includeBody: boolean;
            includeHeaders: boolean;
        };
        slowRequestThreshold: number;
    };
    monitoring: {
        healthCheck: {
            path: string;
            timeout: number;
        };
        metrics: {
            enabled: boolean;
            path: string;
        };
    };
    broadcast: {
        timeout: number;
        maxQueueSize: number;
        batchSize: number;
        batchDelayMs: number;
    };
};
export declare const config: {
    server: {
        port: number;
        host: string;
        trustProxy: boolean;
        requestTimeout: number;
        keepAliveTimeout: number;
        headersTimeout: number;
    };
    cors: {
        origins: string[];
        methods: string[];
        allowedHeaders: string[];
        credentials: boolean;
        maxAge: number;
    };
    rateLimit: {
        global: {
            windowMs: number;
            max: number;
        };
        auth: {
            windowMs: number;
            max: number;
        };
        booking: {
            windowMs: number;
            max: number;
        };
        websocket: {
            maxConnectionsPerUser: number;
            reconnectCooldownMs: number;
        };
    };
    cache: {
        redis: {
            enabled: boolean;
            url: string;
            maxRetries: number;
            connectTimeout: number;
            commandTimeout: number;
        };
        memory: {
            maxSize: number;
            defaultTTL: number;
        };
        ttl: {
            transportersByVehicle: number;
            userProfile: number;
            fcmToken: number;
            otp: number;
            refreshToken: number;
            activeBookings: number;
        };
    };
    database: {
        type: string;
        postgres: {
            host: string | undefined;
            port: number;
            database: string | undefined;
            username: string | undefined;
            password: string | undefined;
            pool: {
                min: number;
                max: number;
                acquireTimeout: number;
                idleTimeout: number;
            };
            ssl: boolean;
        };
    };
    websocket: {
        pingTimeout: number;
        pingInterval: number;
        maxHttpBufferSize: number;
        adapter: string;
        maxRoomsPerSocket: number;
        transports: string[];
        upgradeTimeout: number;
    };
    fcm: {
        batchSize: number;
        retries: number;
        retryDelay: number;
        timeout: number;
    };
    security: {
        jwt: {
            accessTokenExpiry: string;
            refreshTokenExpiry: string;
            algorithm: string;
        };
        maxRequestSize: string;
        maxUrlLength: number;
        helmet: {
            contentSecurityPolicy: boolean;
            crossOriginEmbedderPolicy: boolean;
            hsts: {
                maxAge: number;
                includeSubDomains: boolean;
                preload: boolean;
            };
        };
    };
    logging: {
        level: string;
        format: string;
        requestLogging: {
            enabled: boolean;
            excludePaths: string[];
            includeBody: boolean;
            includeHeaders: boolean;
        };
        slowRequestThreshold: number;
    };
    monitoring: {
        healthCheck: {
            path: string;
            timeout: number;
        };
        metrics: {
            enabled: boolean;
            path: string;
        };
    };
    broadcast: {
        timeout: number;
        maxQueueSize: number;
        batchSize: number;
        batchDelayMs: number;
    };
};
//# sourceMappingURL=production.config.d.ts.map