/**
 * =============================================================================
 * API RESPONSE BUILDER
 * =============================================================================
 * 
 * Standardized response format for all API endpoints.
 * 
 * RESPONSE FORMAT:
 * ```json
 * {
 *   "success": true,
 *   "data": { ... },
 *   "message": "Optional success message",
 *   "meta": {
 *     "pagination": { ... },
 *     "timestamp": "..."
 *   }
 * }
 * ```
 * 
 * USAGE:
 * ```typescript
 * // Simple success
 * return ApiResponse.success(res, data);
 * 
 * // With message
 * return ApiResponse.created(res, user, 'User created successfully');
 * 
 * // With pagination
 * return ApiResponse.paginated(res, items, { page: 1, pageSize: 20, total: 100 });
 * ```
 * 
 * =============================================================================
 */

import { Response } from 'express';
import { HTTP_STATUS } from '../constants';

/**
 * Success response format
 */
export interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  meta?: ResponseMeta;
}

/**
 * Response metadata
 */
export interface ResponseMeta {
  pagination?: PaginationMeta;
  timestamp?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Pagination metadata
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * API Response Builder Class
 */
export class ApiResponse {
  /**
   * 200 OK - Generic success response
   */
  static success<T>(
    res: Response,
    data: T,
    message?: string,
    meta?: Omit<ResponseMeta, 'timestamp'>
  ): Response {
    const response: SuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
      meta: {
        timestamp: new Date().toISOString(),
        ...meta
      }
    };
    return res.status(HTTP_STATUS.OK).json(response);
  }

  /**
   * 201 Created - Resource created successfully
   */
  static created<T>(
    res: Response,
    data: T,
    message: string = 'Resource created successfully'
  ): Response {
    const response: SuccessResponse<T> = {
      success: true,
      data,
      message,
      meta: {
        timestamp: new Date().toISOString()
      }
    };
    return res.status(HTTP_STATUS.CREATED).json(response);
  }

  /**
   * 204 No Content - Success with no response body
   */
  static noContent(res: Response): Response {
    return res.status(HTTP_STATUS.NO_CONTENT).send();
  }

  /**
   * Paginated response with navigation metadata
   */
  static paginated<T>(
    res: Response,
    data: T[],
    pagination: { page: number; pageSize: number; total: number },
    message?: string
  ): Response {
    const totalPages = Math.ceil(pagination.total / pagination.pageSize);
    
    const response: SuccessResponse<T[]> = {
      success: true,
      data,
      ...(message && { message }),
      meta: {
        timestamp: new Date().toISOString(),
        pagination: {
          page: pagination.page,
          pageSize: pagination.pageSize,
          total: pagination.total,
          totalPages,
          hasNext: pagination.page < totalPages,
          hasPrev: pagination.page > 1
        }
      }
    };
    return res.status(HTTP_STATUS.OK).json(response);
  }

  /**
   * Success with custom status code
   */
  static custom<T>(
    res: Response,
    statusCode: number,
    data: T,
    message?: string
  ): Response {
    const response: SuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
      meta: {
        timestamp: new Date().toISOString()
      }
    };
    return res.status(statusCode).json(response);
  }

  /**
   * Success response for list endpoints (with optional count)
   */
  static list<T>(
    res: Response,
    data: T[],
    message?: string
  ): Response {
    return this.success(res, data, message, { count: data.length });
  }

  /**
   * Success response for operations (no data, just confirmation)
   */
  static ok(res: Response, message: string = 'Operation successful'): Response {
    return this.success(res, null, message);
  }

  /**
   * Response for file downloads
   */
  static download(
    res: Response,
    buffer: Buffer,
    filename: string,
    mimeType: string
  ): Response {
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  }

  /**
   * Response for streaming data
   */
  static stream(
    res: Response,
    mimeType: string = 'application/octet-stream'
  ): Response {
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Transfer-Encoding', 'chunked');
    return res;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Calculate pagination values from query parameters
 */
export function parsePagination(query: {
  page?: string | number;
  pageSize?: string | number;
  limit?: string | number;
}): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, parseInt(String(query.page || 1), 10));
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(String(query.pageSize || query.limit || 20), 10))
  );
  const offset = (page - 1) * pageSize;

  return { page, pageSize, offset };
}

/**
 * Build pagination metadata from results
 */
export function buildPaginationMeta(
  page: number,
  pageSize: number,
  total: number
): PaginationMeta {
  const totalPages = Math.ceil(total / pageSize);
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1
  };
}

// =============================================================================
// TYPE EXPORTS (types already exported above with their definitions)
// =============================================================================
