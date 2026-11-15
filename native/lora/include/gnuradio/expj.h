// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "compat.hpp"
inline gr_complex gr_expj(double x){return {float(std::cos(x)),float(std::sin(x))};}
