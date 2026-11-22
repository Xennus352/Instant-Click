import { AuthRepository } from "@/repositories/AuthRepository";

export const AuthService = {
  async getUser(id: string) {
    return AuthRepository.findUserById(id);
  },
};
