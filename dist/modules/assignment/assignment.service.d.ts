/**
 * =============================================================================
 * ASSIGNMENT MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for truck assignments.
 * Transporters assign their trucks to customer bookings.
 * =============================================================================
 */
import { AssignmentRecord } from '../../shared/database/db';
import { CreateAssignmentInput, UpdateStatusInput, GetAssignmentsQuery } from './assignment.schema';
declare class AssignmentService {
    createAssignment(transporterId: string, data: CreateAssignmentInput): Promise<AssignmentRecord>;
    getAssignments(userId: string, userRole: string, query: GetAssignmentsQuery): Promise<{
        assignments: AssignmentRecord[];
        total: number;
        hasMore: boolean;
    }>;
    getDriverAssignments(driverId: string, query: GetAssignmentsQuery): Promise<{
        assignments: AssignmentRecord[];
        total: number;
        hasMore: boolean;
    }>;
    getAssignmentById(assignmentId: string, userId: string, userRole: string): Promise<AssignmentRecord>;
    acceptAssignment(assignmentId: string, driverId: string): Promise<AssignmentRecord>;
    updateStatus(assignmentId: string, driverId: string, data: UpdateStatusInput): Promise<AssignmentRecord>;
    cancelAssignment(assignmentId: string, userId: string): Promise<void>;
}
export declare const assignmentService: AssignmentService;
export {};
//# sourceMappingURL=assignment.service.d.ts.map