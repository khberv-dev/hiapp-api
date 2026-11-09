import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { User } from './entities/user.entity.js';
import { UserService } from './user.service.js';

describe('UserService.getMe', () => {
  const serviceReturning = (user: Partial<User> | null) => {
    const qb = {
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getOne: vi.fn().mockResolvedValue(user),
    };
    const repo = {
      createQueryBuilder: vi.fn().mockReturnValue(qb),
    } as unknown as Repository<User>;
    return { service: new UserService(repo), qb };
  };

  const base = {
    id: 'u1',
    firstName: 'Ann',
    lastName: null,
    email: 'ann@example.com',
    googleId: 'g1',
  };

  it('returns the profile and whether a password is set, never the hash', async () => {
    const { service, qb } = serviceReturning({
      ...base,
      password: 'scrypt$salt$hash',
    });
    const me = await service.getMe('u1');

    expect(me).toEqual({
      id: 'u1',
      firstName: 'Ann',
      lastName: null,
      email: 'ann@example.com',
      hasPassword: true,
    });
    expect(qb.addSelect).toHaveBeenCalledWith('user.password');
    expect(qb.where).toHaveBeenCalledWith('user.id = :id', { id: 'u1' });
  });

  it('reports hasPassword: false when none is set', async () => {
    const { service } = serviceReturning({ ...base, password: null });
    await expect(service.getMe('u1')).resolves.toMatchObject({
      hasPassword: false,
    });
  });

  it('throws 404 when the user no longer exists', async () => {
    const { service } = serviceReturning(null);
    await expect(service.getMe('gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
