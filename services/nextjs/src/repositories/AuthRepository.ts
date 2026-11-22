import { prisma } from "@/lib/prisma";

export const AuthRepository = {
  findUserById(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, image: true, role: true, emailVerified: true, createdAt: true, updatedAt: true } });
  },
  findUserByEmail(email: string) {
    return prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, email: true, name: true, image: true, role: true, emailVerified: true, createdAt: true, updatedAt: true } });
  },
};
