/**
 * =============================================================================
 * USER MODULE - SERVICE
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { UpdateProfileInput } from './user.schema';

// In-memory store (replace with DB in production)
const userStore = new Map<string, User>();

interface User {
  id: string;
  phone: string;
  role: string;
  name?: string;
  email?: string;
  businessName?: string;
  gstNumber?: string;
  address?: string;
  city?: string;
  state?: string;
  profilePicture?: string;
  createdAt: Date;
  updatedAt: Date;
}

class UserService {
  /**
   * Get user by ID
   */
  async getUserById(userId: string): Promise<User> {
    const user = userStore.get(userId);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    return user;
  }

  /**
   * Update user profile
   */
  async updateProfile(userId: string, data: UpdateProfileInput): Promise<User> {
    const user = userStore.get(userId);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    
    // Update fields
    const updatedUser: User = {
      ...user,
      ...data,
      updatedAt: new Date()
    };
    
    userStore.set(userId, updatedUser);
    logger.info('User profile updated', { userId });
    
    return updatedUser;
  }

  /**
   * Create or update user (called from auth service)
   */
  async upsertUser(userData: Partial<User> & { id: string; phone: string; role: string }): Promise<User> {
    const existing = userStore.get(userData.id);
    
    const user: User = {
      ...existing,
      ...userData,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date()
    } as User;
    
    userStore.set(user.id, user);
    return user;
  }
}

export const userService = new UserService();
