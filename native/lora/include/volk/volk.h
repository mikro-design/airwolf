// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "compat.hpp"
namespace volk {template<class T>using vector=std::vector<T>;}
inline void volk_32fc_x2_multiply_32fc(gr_complex*out,const gr_complex*a,const gr_complex*b,unsigned n){for(unsigned i=0;i<n;++i)out[i]=a[i]*b[i];}
inline void volk_32fc_conjugate_32fc(gr_complex*out,const gr_complex*a,unsigned n){for(unsigned i=0;i<n;++i)out[i]=std::conj(a[i]);}
inline void volk_32fc_magnitude_squared_32f(float*out,const gr_complex*a,unsigned n){for(unsigned i=0;i<n;++i)out[i]=std::norm(a[i]);}
inline void volk_32f_accumulator_s32f(float*out,const float*a,unsigned n){*out=0;for(unsigned i=0;i<n;++i)*out+=a[i];}
