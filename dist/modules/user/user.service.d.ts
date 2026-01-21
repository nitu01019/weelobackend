/**
 * =============================================================================
 * USER MODULE - SERVICE
 * =============================================================================
 */
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
declare class UserService {
    /**
     * Get user by ID
     */
    getUserById(userId: string): Promise<User>;
    /**
     * Update user profile
     */
    updateProfile(userId: string, data: UpdateProfileInput): Promise<User>;
    /**
     * Create or update user (called from auth service)
     */
    upsertUser(userData: Partial<User> & {
        id: string;
        phone: string;
        role: string;
    }): Promise<User>;
}
export declare const userService: UserService;
export {};
//# sourceMappingURL=user.service.d.ts.map