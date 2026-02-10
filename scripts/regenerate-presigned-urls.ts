/**
 * Script to regenerate presigned URLs for all existing driver photos
 * Run: npx ts-node scripts/regenerate-presigned-urls.ts
 */

import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const prisma = new PrismaClient();

const s3Client = new S3Client({
  region: process.env.AWS_SNS_REGION || 'ap-south-1',
});

const bucket = process.env.S3_BUCKET || 'weelo-driver-profiles-production';

async function regeneratePresignedUrl(oldUrl: string): Promise<string> {
  try {
    // Extract the S3 key from the old URL
    const urlParts = oldUrl.split('.com/');
    if (urlParts.length < 2) {
      console.error('Invalid URL format:', oldUrl);
      return oldUrl;
    }
    
    const key = urlParts[1];
    
    // Generate presigned URL
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    
    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 604800, // 7 days
    });
    
    return presignedUrl;
  } catch (error: any) {
    console.error('Error generating presigned URL:', error.message);
    return oldUrl; // Return old URL if generation fails
  }
}

async function main() {
  console.log('🔄 Starting presigned URL regeneration...\n');
  
  // Get all drivers with photos
  const drivers = await prisma.user.findMany({
    where: {
      role: 'driver',
      OR: [
        { profilePhoto: { not: null } },
        { licenseFrontPhoto: { not: null } },
        { licenseBackPhoto: { not: null } },
      ],
    },
  });
  
  console.log(`Found ${drivers.length} drivers with photos\n`);
  
  for (const driver of drivers) {
    console.log(`Processing driver: ${driver.name || driver.phone}`);
    
    const updates: any = {};
    
    // Regenerate profile photo URL
    if (driver.profilePhoto && !driver.profilePhoto.includes('X-Amz-Signature')) {
      console.log('  - Regenerating profile photo URL...');
      updates.profilePhoto = await regeneratePresignedUrl(driver.profilePhoto);
    }
    
    // Regenerate license front URL
    if (driver.licenseFrontPhoto && !driver.licenseFrontPhoto.includes('X-Amz-Signature')) {
      console.log('  - Regenerating license front URL...');
      updates.licenseFrontPhoto = await regeneratePresignedUrl(driver.licenseFrontPhoto);
    }
    
    // Regenerate license back URL
    if (driver.licenseBackPhoto && !driver.licenseBackPhoto.includes('X-Amz-Signature')) {
      console.log('  - Regenerating license back URL...');
      updates.licenseBackPhoto = await regeneratePresignedUrl(driver.licenseBackPhoto);
    }
    
    // Update database
    if (Object.keys(updates).length > 0) {
      await prisma.user.update({
        where: { id: driver.id },
        data: updates,
      });
      console.log('  ✅ Updated!\n');
    } else {
      console.log('  ℹ️  Already has presigned URLs\n');
    }
  }
  
  console.log('✅ All URLs regenerated successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
