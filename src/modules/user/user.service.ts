/**
 * =============================================================================
 * USER MODULE - SERVICE
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { prismaClient, UserRole } from '../../shared/database/prisma.service';
import { UpdateProfileInput } from './user.schema';

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
    const user = await prismaClient.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    return {
      id: user.id,
      phone: user.phone,
      role: user.role,
      name: user.name ?? undefined,
      email: user.email ?? undefined,
      businessName: user.businessName ?? undefined,
      gstNumber: user.gstNumber ?? undefined,
      address: user.businessAddress ?? undefined,
      city: undefined,
      state: undefined,
      profilePicture: user.profilePhoto ?? undefined,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }

  /**
   * Update user profile
   */
  async updateProfile(userId: string, data: UpdateProfileInput): Promise<User> {
    // Verify user exists
    const existing = await prismaClient.user.findUnique({ where: { id: userId } });
    if (!existing) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    // Build update payload — only include fields that are provided
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.businessName !== undefined) updateData.businessName = data.businessName;
    if (data.gstNumber !== undefined) updateData.gstNumber = data.gstNumber;
    if ((data as any).profilePicture !== undefined) updateData.profilePhoto = (data as any).profilePicture;

    const updated = await prismaClient.user.update({
      where: { id: userId },
      data: updateData
    });

    logger.info('User profile updated', { userId });

    return {
      id: updated.id,
      phone: updated.phone,
      role: updated.role,
      name: updated.name ?? undefined,
      email: updated.email ?? undefined,
      businessName: updated.businessName ?? undefined,
      gstNumber: updated.gstNumber ?? undefined,
      address: updated.businessAddress ?? undefined,
      city: undefined,
      state: undefined,
      profilePicture: updated.profilePhoto ?? undefined,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  }

  /**
   * Create or update user (called from auth service)
   */
  async upsertUser(userData: Partial<User> & { id: string; phone: string; role: string }): Promise<User> {
    const upserted = await prismaClient.user.upsert({
      where: { id: userData.id },
      create: {
        id: userData.id,
        phone: userData.phone,
        role: userData.role as UserRole,
        name: userData.name ?? 'User',
        email: userData.email,
        businessName: userData.businessName,
        gstNumber: userData.gstNumber,
        businessAddress: userData.address,
        profilePhoto: userData.profilePicture,
        isVerified: false,
        isActive: true
      },
      update: {
        phone: userData.phone,
        ...(userData.name !== undefined && { name: userData.name }),
        ...(userData.email !== undefined && { email: userData.email }),
        ...(userData.businessName !== undefined && { businessName: userData.businessName }),
        ...(userData.gstNumber !== undefined && { gstNumber: userData.gstNumber }),
        ...(userData.address !== undefined && { businessAddress: userData.address }),
        ...(userData.profilePicture !== undefined && { profilePhoto: userData.profilePicture })
      }
    });

    return {
      id: upserted.id,
      phone: upserted.phone,
      role: upserted.role,
      name: upserted.name ?? undefined,
      email: upserted.email ?? undefined,
      businessName: upserted.businessName ?? undefined,
      gstNumber: upserted.gstNumber ?? undefined,
      address: upserted.businessAddress ?? undefined,
      city: undefined,
      state: undefined,
      profilePicture: upserted.profilePhoto ?? undefined,
      createdAt: upserted.createdAt,
      updatedAt: upserted.updatedAt
    };
  }
}

export const userService = new UserService();
