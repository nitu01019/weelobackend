/**
 * Temporary route to regenerate presigned URLs for existing photos
 */
import { Router, Request, Response } from 'express';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';

const router = Router();

const s3Client = new S3Client({
  region: process.env.AWS_SNS_REGION || 'ap-south-1',
});

const bucket = process.env.S3_BUCKET || 'weelo-driver-profiles-production';

async function generatePresignedUrl(oldUrl: string): Promise<string> {
  try {
    const urlParts = oldUrl.split('.com/');
    if (urlParts.length < 2) return oldUrl;
    
    const key = urlParts[1];
    
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    
    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 604800, // 7 days
    });
    
    return presignedUrl;
  } catch (error: any) {
    logger.error('Failed to generate presigned URL', { error: error.message });
    return oldUrl;
  }
}

/**
 * POST /api/v1/driver/regenerate-urls
 * Regenerate presigned URLs for all driver photos
 */
router.post('/regenerate-urls', async (req: Request, res: Response) => {
  try {
    logger.info('[ADMIN] Regenerating presigned URLs...');
    
    // Get all drivers from database
    const allUsers = await db.getAllUsers();
    const drivers = allUsers.filter(user => 
      user.role === 'driver' && 
      (user.profilePhoto || user.licenseFrontPhoto || user.licenseBackPhoto)
    );
    
    logger.info(`Found ${drivers.length} drivers with photos`);
    
    let updated = 0;
    
    for (const driver of drivers) {
      const updates: any = {};
      
      if (driver.profilePhoto && !driver.profilePhoto.includes('X-Amz-Signature')) {
        updates.profilePhoto = await generatePresignedUrl(driver.profilePhoto);
      }
      
      if (driver.licenseFrontPhoto && !driver.licenseFrontPhoto.includes('X-Amz-Signature')) {
        updates.licenseFrontPhoto = await generatePresignedUrl(driver.licenseFrontPhoto);
      }
      
      if (driver.licenseBackPhoto && !driver.licenseBackPhoto.includes('X-Amz-Signature')) {
        updates.licenseBackPhoto = await generatePresignedUrl(driver.licenseBackPhoto);
      }
      
      if (Object.keys(updates).length > 0) {
        await db.updateUser(driver.id, updates);
        updated++;
        logger.info(`Updated URLs for driver: ${driver.name || driver.phone}`);
      }
    }
    
    logger.info(`✅ Regenerated URLs for ${updated} drivers`);
    
    res.json({
      success: true,
      message: `Regenerated presigned URLs for ${updated} drivers`,
      data: { updated, total: drivers.length },
    });
  } catch (error: any) {
    logger.error('Failed to regenerate URLs', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'REGENERATION_FAILED', message: error.message },
    });
  }
});

export default router;
